import { getAuth } from "@clerk/express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  ListDriveItemsQueryParams,
  ListDriveItemsResponse,
} from "@workspace/api-zod";
import { appOwnerTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Router, type RequestHandler } from "express";

const APP_OWNER_ROW_ID = 1;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_FIELDS =
  "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink)";

const router = Router();

const requireSignIn: RequestHandler = (req, res, next) => {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  res.locals.userId = userId;
  next();
};

router.use(requireSignIn);

async function getAppOwner() {
  const [owner] = await db
    .select()
    .from(appOwnerTable)
    .where(eq(appOwnerTable.id, APP_OWNER_ROW_ID))
    .limit(1);

  return owner ?? null;
}

router.get("/access", async (_req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  const owner = await getAppOwner();

  res.status(200).json({
    claimed: owner !== null,
    isOwner: owner?.userId === userId,
  });
});

router.post("/claim", async (_req, res): Promise<void> => {
  const userId = res.locals.userId as string;

  await db
    .insert(appOwnerTable)
    .values({ id: APP_OWNER_ROW_ID, userId })
    .onConflictDoNothing();

  const owner = await getAppOwner();
  if (!owner || owner.userId !== userId) {
    res.status(409).json({
      error: "This app has already been claimed by another account.",
    });
    return;
  }

  res.status(200).json({ claimed: true, isOwner: true });
});

router.get("/items", async (req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  const owner = await getAppOwner();
  if (!owner || owner.userId !== userId) {
    res.status(403).json({
      error: "This account does not have access to the app's Google Drive.",
    });
    return;
  }

  const parsedQuery = ListDriveItemsQueryParams.safeParse(req.query);
  if (!parsedQuery.success) {
    res.status(400).json({ error: "The folder or page selection is invalid." });
    return;
  }

  const parentId = parsedQuery.data.parentId ?? "root";
  if (
    parentId !== "root" &&
    !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)
  ) {
    res.status(400).json({ error: "The selected folder ID is invalid." });
    return;
  }

  const driveQuery = new URLSearchParams({
    q: `'${parentId}' in parents and trashed = false`,
    fields: DRIVE_FIELDS,
    pageSize: "100",
    orderBy: "name",
  });
  if (parsedQuery.data.pageToken) {
    driveQuery.set("pageToken", parsedQuery.data.pageToken);
  }

  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy(
      "google-drive",
      `/drive/v3/files?${driveQuery.toString()}`,
      { method: "GET" },
    );

    if (!response.ok) {
      req.log.warn(
        { status: response.status },
        "Google Drive folder listing request failed",
      );
      if (response.status === 404) {
        res.status(404).json({
          error: "That Google Drive folder could not be found or opened.",
        });
        return;
      }
      res.status(502).json({
        error:
          "Google Drive could not be reached. Check the connected account and try again.",
      });
      return;
    }

    const driveResult: unknown = await response.json();
    if (
      typeof driveResult !== "object" ||
      driveResult === null ||
      !("files" in driveResult) ||
      !Array.isArray(driveResult.files)
    ) {
      req.log.warn("Google Drive returned an unexpected folder listing");
      res.status(502).json({ error: "Google Drive returned an unreadable result." });
      return;
    }

    const result = driveResult as {
      files: Array<Record<string, unknown>>;
      nextPageToken?: unknown;
      incompleteSearch?: unknown;
    };
    const items = result.files.map((file) => {
      if (
        typeof file.id !== "string" ||
        typeof file.name !== "string" ||
        typeof file.mimeType !== "string"
      ) {
        throw new Error("Google Drive returned incomplete file metadata");
      }

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        isFolder: file.mimeType === DRIVE_FOLDER_MIME_TYPE,
        modifiedTime:
          typeof file.modifiedTime === "string" ? file.modifiedTime : null,
        webViewLink:
          typeof file.webViewLink === "string" ? file.webViewLink : null,
      };
    });

    const payload = {
      parentId,
      items,
      nextPageToken:
        typeof result.nextPageToken === "string" ? result.nextPageToken : null,
      incompleteSearch: result.incompleteSearch === true,
    };
    const validated = ListDriveItemsResponse.safeParse(payload);
    if (!validated.success) {
      req.log.warn("Google Drive listing did not match the expected metadata shape");
      res.status(502).json({ error: "Google Drive returned an unreadable result." });
      return;
    }

    res.status(200).json(validated.data);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Google Drive folder listing failed",
    );
    res.status(502).json({
      error: "Google Drive could not be reached. Check the connection and try again.",
    });
  }
});

export default router;
