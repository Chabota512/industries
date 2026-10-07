import { getAuth } from "@clerk/express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  ListDriveItemsQueryParams,
  ListDriveItemsResponse,
} from "@workspace/api-zod";
import { appOwnerTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import express, { Router, type RequestHandler } from "express";

const APP_OWNER_ROW_ID = 1;
const DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const DRIVE_SHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const DRIVE_SLIDES_MIME_TYPE = "application/vnd.google-apps.presentation";
const DRIVE_DRAWING_MIME_TYPE = "application/vnd.google-apps.drawing";
const MAX_DRIVE_FILE_BYTES = 15 * 1024 * 1024;
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

async function userOwnsApp(userId: string): Promise<boolean> {
  const owner = await getAppOwner();
  return owner?.userId === userId;
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

router.get("/files/:fileId/content", async (req, res): Promise<void> => {
  const userId = res.locals.userId as string;
  if (!(await userOwnsApp(userId))) {
    res.status(403).json({
      error: "This account does not have access to the app's Google Drive.",
    });
    return;
  }

  const fileId = Array.isArray(req.params.fileId)
    ? req.params.fileId[0]
    : req.params.fileId;
  if (!fileId || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) {
    res.status(400).json({ error: "The selected Drive file ID is invalid." });
    return;
  }

  try {
    const connectors = new ReplitConnectors();
    const metadataResponse = await connectors.proxy(
      "google-drive",
      `/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
      { method: "GET" },
    );
    if (!metadataResponse.ok) {
      if (metadataResponse.status === 404) {
        res.status(404).json({ error: "That Drive file could not be found." });
        return;
      }
      if (metadataResponse.status === 403) {
        res.status(403).json({ error: "Google Drive did not permit reading this file." });
        return;
      }
      req.log.warn(
        { status: metadataResponse.status },
        "Google Drive file metadata request failed",
      );
      res.status(502).json({ error: "Google Drive could not read that file." });
      return;
    }

    const metadata: unknown = await metadataResponse.json();
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("name" in metadata) ||
      typeof metadata.name !== "string" ||
      !("mimeType" in metadata) ||
      typeof metadata.mimeType !== "string"
    ) {
      res.status(502).json({ error: "Google Drive returned unreadable file details." });
      return;
    }

    if (metadata.mimeType === DRIVE_FOLDER_MIME_TYPE) {
      res.status(400).json({ error: "Select a file, not a folder." });
      return;
    }
    if ("size" in metadata && typeof metadata.size === "string") {
      const size = Number(metadata.size);
      if (Number.isFinite(size) && size > MAX_DRIVE_FILE_BYTES) {
        res.status(413).json({
          error: "This file is too large to preview here. Open it in Google Drive instead.",
        });
        return;
      }
    }

    let contentPath = `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    if (metadata.mimeType.startsWith("application/vnd.google-apps.")) {
      const exportMimeType =
        metadata.mimeType === DRIVE_SHEET_MIME_TYPE
          ? "text/csv"
          : [
                DRIVE_DOC_MIME_TYPE,
                DRIVE_SLIDES_MIME_TYPE,
                DRIVE_DRAWING_MIME_TYPE,
              ].includes(metadata.mimeType)
            ? "application/pdf"
            : null;
      if (!exportMimeType) {
        res.status(415).json({
          error: "Google Drive cannot preview this file type in the app.",
        });
        return;
      }
      contentPath =
        `/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=` +
        encodeURIComponent(exportMimeType);
    }

    const contentResponse = await connectors.proxy("google-drive", contentPath, {
      method: "GET",
    });
    if (!contentResponse.ok) {
      if (contentResponse.status === 404) {
        res.status(404).json({ error: "That Drive file could not be opened." });
        return;
      }
      req.log.warn(
        { status: contentResponse.status },
        "Google Drive file content request failed",
      );
      res.status(502).json({ error: "Google Drive could not open that file." });
      return;
    }

    const advertisedLength = Number(contentResponse.headers.get("content-length"));
    if (Number.isFinite(advertisedLength) && advertisedLength > MAX_DRIVE_FILE_BYTES) {
      res.status(413).json({
        error: "This file is too large to preview here. Open it in Google Drive instead.",
      });
      return;
    }
    const content = Buffer.from(await contentResponse.arrayBuffer());
    if (content.byteLength > MAX_DRIVE_FILE_BYTES) {
      res.status(413).json({
        error: "This file is too large to preview here. Open it in Google Drive instead.",
      });
      return;
    }

    const contentType =
      contentResponse.headers.get("content-type") ?? metadata.mimeType;
    const safeInlineTypes = new Set([
      "application/pdf",
      "text/csv",
      "text/plain",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    const disposition = safeInlineTypes.has(mediaType) ? "inline" : "attachment";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(content);
  } catch (error) {
    req.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "Google Drive file preview failed",
    );
    res.status(502).json({ error: "Google Drive could not preview that file." });
  }
});

router.post(
  "/upload",
  express.raw({ type: "application/octet-stream", limit: MAX_DRIVE_FILE_BYTES }),
  async (req, res): Promise<void> => {
    const userId = res.locals.userId as string;
    if (!(await userOwnsApp(userId))) {
      res.status(403).json({
        error: "This account does not have access to the app's Google Drive.",
      });
      return;
    }

    const rawParentId = req.query.parentId;
    if (rawParentId !== undefined && typeof rawParentId !== "string") {
      res.status(400).json({ error: "The selected Drive folder is invalid." });
      return;
    }
    const parentId = rawParentId ?? "root";
    if (parentId !== "root" && !/^[A-Za-z0-9_-]{1,200}$/.test(parentId)) {
      res.status(400).json({ error: "The selected Drive folder is invalid." });
      return;
    }

    const encodedName = req.get("X-File-Name");
    if (!encodedName || encodedName.length > 720) {
      res.status(400).json({ error: "Choose a file with a valid name." });
      return;
    }
    let decodedName: string;
    try {
      decodedName = decodeURIComponent(encodedName);
    } catch {
      res.status(400).json({ error: "The file name could not be read." });
      return;
    }
    const name = decodedName
      .replace(/[\\/]/g, "-")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (!name || name.length > 240) {
      res.status(400).json({ error: "Choose a file with a valid name." });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      res.status(400).json({ error: "Choose a non-empty file to upload." });
      return;
    }
    if (req.body.byteLength > MAX_DRIVE_FILE_BYTES) {
      res.status(413).json({ error: "Files must be 15 MB or smaller." });
      return;
    }

    const requestedMimeType = req.get("X-File-Mime-Type") ?? "";
    const mimeType =
      requestedMimeType.length <= 120 &&
      /^[\w.+-]+\/[\w.+-]+$/.test(requestedMimeType)
      ? requestedMimeType
      : "application/octet-stream";
    const boundary = `replit-${randomUUID()}`;
    const metadata: {
      name: string;
      mimeType: string;
      parents?: string[];
    } = { name, mimeType };
    if (parentId !== "root") metadata.parents = [parentId];

    const multipartBody = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      ),
      req.body,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    try {
      const uploadQuery = new URLSearchParams({
        uploadType: "multipart",
        supportsAllDrives: "true",
        fields: "id,name,mimeType,modifiedTime,webViewLink",
      });
      const connectors = new ReplitConnectors();
      const uploadResponse = await connectors.proxy(
        "google-drive",
        `/upload/drive/v3/files?${uploadQuery.toString()}`,
        {
          method: "POST",
          headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
          body: multipartBody,
        },
      );

      if (!uploadResponse.ok) {
        req.log.warn(
          { status: uploadResponse.status },
          "Google Drive file upload failed",
        );
        if (uploadResponse.status === 403) {
          res.status(403).json({
            error: "Google Drive did not permit an upload to that folder.",
          });
          return;
        }
        res.status(502).json({ error: "Google Drive could not save that file." });
        return;
      }

      const uploaded: unknown = await uploadResponse.json();
      if (
        typeof uploaded !== "object" ||
        uploaded === null ||
        !("id" in uploaded) ||
        typeof uploaded.id !== "string" ||
        !("name" in uploaded) ||
        typeof uploaded.name !== "string" ||
        !("mimeType" in uploaded) ||
        typeof uploaded.mimeType !== "string"
      ) {
        res.status(502).json({ error: "Google Drive returned unreadable upload details." });
        return;
      }

      const item = {
        id: uploaded.id,
        name: uploaded.name,
        mimeType: uploaded.mimeType,
        isFolder: false,
        modifiedTime:
          "modifiedTime" in uploaded && typeof uploaded.modifiedTime === "string"
            ? uploaded.modifiedTime
            : null,
        webViewLink:
          "webViewLink" in uploaded && typeof uploaded.webViewLink === "string"
            ? uploaded.webViewLink
            : null,
      };
      const validated = ListDriveItemsResponse.safeParse({
        parentId,
        items: [item],
        nextPageToken: null,
        incompleteSearch: false,
      });
      if (!validated.success) {
        req.log.warn("Google Drive upload did not match the expected metadata shape");
        res.status(502).json({ error: "Google Drive returned unreadable upload details." });
        return;
      }

      res.status(201).json(validated.data.items[0]);
    } catch (error) {
      req.log.error(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Google Drive file upload request failed",
      );
      res.status(502).json({ error: "Google Drive could not save that file." });
    }
  },
);

export default router;
