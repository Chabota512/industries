import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListDriveItemsQueryKey,
  getPreviewDriveFileUrl,
  useListDriveItems,
  uploadDriveFile,
} from "@workspace/api-client-react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  LockKeyhole,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  modifiedTime: string | null;
  webViewLink: string | null;
};

type DriveOfficeSeed = {
  companyName: string;
  town: string;
  sourceUrl: string;
  sourceDriveFileId: string;
  sourceFileName: string;
};

type DriveOffice = {
  companyName: string;
  town: string;
  sourceDriveFileId?: string;
};

type DriveSourcePanelProps<T extends DriveOffice> = {
  offices: T[];
  setOffices: (offices: T[]) => void;
  createOffice: (seed: DriveOfficeSeed) => T;
};

function companyNameFromFilename(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export default function DriveSourcePanel<T extends DriveOffice>({
  offices,
  setOffices,
  createOffice,
}: DriveSourcePanelProps<T>) {
  const queryClient = useQueryClient();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [folderStack, setFolderStack] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [pageTokens, setPageTokens] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [candidateNames, setCandidateNames] = useState<Record<string, string>>(
    {},
  );
  const [reviewItems, setReviewItems] = useState<DriveFile[]>([]);
  const [previewItem, setPreviewItem] = useState<DriveFile | null>(null);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const parentId = folderStack.at(-1)?.id;
  const pageToken = pageTokens.at(-1);
  const params = { parentId, pageToken };
  const query = useListDriveItems(params, {
    query: {
      queryKey: getListDriveItemsQueryKey(params),
      enabled: true,
    },
  });
  const items = query.data?.items ?? [];
  const nextPageToken = query.data?.nextPageToken;
  const selectedItems = items.filter(
    (item) => !item.isFolder && selected[item.id],
  );
  const town = folderStack[0]?.name ?? "";

  function resetFolderPage(): void {
    setPageTokens([undefined]);
    setSelected({});
  }

  function navigateToFolder(id: string, name: string): void {
    setFolderStack((current) => [...current, { id, name }]);
    resetFolderPage();
  }

  function reviewSelection(): void {
    setReviewItems(selectedItems);
    setCandidateNames((current) => {
      const next = { ...current };
      for (const item of selectedItems) {
        next[item.id] ??= companyNameFromFilename(item.name);
      }
      return next;
    });
    setReviewOpen(true);
  }

  function importReviewedItems(): void {
    const newItems = reviewItems.filter(
      (item) => !offices.some((office) => office.sourceDriveFileId === item.id),
    );
    const records = newItems.map((item) =>
      createOffice({
        companyName:
          candidateNames[item.id]?.trim() ||
          companyNameFromFilename(item.name) ||
          item.name,
        town,
        sourceUrl: item.webViewLink ?? "",
        sourceDriveFileId: item.id,
        sourceFileName: item.name,
      }),
    );
    setOffices([...records, ...offices]);
    const alreadyAdded = reviewItems.length - newItems.length;
    setFeedback(
      records.length
        ? `${records.length} Drive-backed candidate ${records.length === 1 ? "added" : "names added"}. Confirm the details before planning a visit.${alreadyAdded ? ` ${alreadyAdded} already imported.` : ""}`
        : "Those Drive files are already in your company list.",
    );
    setReviewOpen(false);
    setReviewItems([]);
    setSelected({});
  }

  async function uploadSelectedFiles(): Promise<void> {
    if (!uploadFiles.length || uploading) return;

    setUploading(true);
    setFeedback("");
    const uploaded: DriveFile[] = [];
    const failed: string[] = [];

    for (const file of uploadFiles) {
      try {
        const item = await uploadDriveFile(
          file,
          { parentId },
          {
            headers: {
              "X-File-Name": encodeURIComponent(file.name),
              "X-File-Mime-Type": file.type || "application/octet-stream",
            },
          },
        );
        uploaded.push(item);
      } catch {
        failed.push(file.name);
      }
    }

    if (uploaded.length) {
      const names: Record<string, string> = {};
      for (const item of uploaded) {
        names[item.id] = companyNameFromFilename(item.name);
      }
      setCandidateNames((current) => ({ ...current, ...names }));
      setReviewItems(uploaded);
      setReviewOpen(true);
      setSelected(Object.fromEntries(uploaded.map((item) => [item.id, true])));
      setPageTokens([undefined]);
      void queryClient.invalidateQueries({
        queryKey: getListDriveItemsQueryKey({ parentId }),
      });
    }

    const savedMessage = uploaded.length
      ? `${uploaded.length} ${uploaded.length === 1 ? "letter saved" : "letters saved"} to the open Drive folder. Review the company names next.`
      : "";
    const failureMessage = failed.length
      ? `${failed.length} file${failed.length === 1 ? "" : "s"} could not be saved: ${failed.join(", ")}.`
      : "";
    setFeedback([savedMessage, failureMessage].filter(Boolean).join(" "));
    setUploadFiles([]);
    if (uploadInput.current) uploadInput.current.value = "";
    setUploading(false);
  }

  return (
    <section className="panel drive-panel">
      <div className="panel-heading">
        <div className="step-no">
          <FolderOpen size={16} />
        </div>
        <div>
          <h2>Letters in Google Drive</h2>
          <p>
            Your town folders and letters supply the company names for this
            companion.
          </p>
        </div>
      </div>

      <div className="drive-security">
        <LockKeyhole size={16} />
        <span>
          Only your claimed account can browse, preview, or add files. Uploads
          create new Drive files; they do not replace or remove existing ones.
        </span>
      </div>

      <div className="drive-toolbar">
        <nav className="drive-breadcrumb" aria-label="Google Drive folders">
          <button
            type="button"
            onClick={() => {
              setFolderStack([]);
              resetFolderPage();
            }}
          >
            My Drive
          </button>
          {folderStack.map((folder, index) => (
            <span key={folder.id}>
              <ChevronRight size={13} />
              <button
                type="button"
                onClick={() => {
                  setFolderStack(folderStack.slice(0, index + 1));
                  resetFolderPage();
                }}
              >
                {folder.name}
              </button>
            </span>
          ))}
        </nav>
        <button
          type="button"
          className="btn"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw size={14} />
          {query.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {query.isLoading ? (
        <div className="drive-loading" aria-label="Loading Google Drive items">
          <i />
          <i />
          <i />
        </div>
      ) : query.isError ? (
        <div className="drive-error" role="alert">
          <p>Drive items could not be loaded right now.</p>
          <button
            type="button"
            className="btn"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="drive-empty">
          <Folder size={22} />
          <strong>This folder is empty</strong>
          <span>Choose another town folder or upload a letter below.</span>
        </div>
      ) : (
        <div className="drive-items">
          {items.map((item) => (
            <div className="drive-item" key={item.id}>
              {item.isFolder ? (
                <button
                  type="button"
                  className="drive-item-open"
                  onClick={() => navigateToFolder(item.id, item.name)}
                >
                  <Folder size={17} />
                  <strong>{item.name}</strong>
                  <ChevronRight size={15} />
                </button>
              ) : (
                <label className="drive-file-select">
                  <input
                    type="checkbox"
                    checked={!!selected[item.id]}
                    onChange={(event) =>
                      setSelected((current) => ({
                        ...current,
                        [item.id]: event.target.checked,
                      }))
                    }
                  />
                  <FileText size={16} />
                  <strong>{item.name}</strong>
                </label>
              )}
              <span className="drive-kind">
                {item.isFolder
                  ? "Folder"
                  : item.mimeType.split("/").pop() || "File"}
              </span>
              <time>
                {item.modifiedTime
                  ? new Date(item.modifiedTime).toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })
                  : "Date unavailable"}
              </time>
              {!item.isFolder && (
                <div className="drive-item-actions">
                  <button
                    type="button"
                    className="drive-preview-button"
                    onClick={() => setPreviewItem(item)}
                  >
                    <Eye size={14} />
                    Preview
                  </button>
                  {item.webViewLink && (
                    <a
                      className="drive-view"
                      href={item.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open in Drive
                    </a>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {query.data?.incompleteSearch && (
        <p className="drive-incomplete">
          Google Drive reported an incomplete folder search; some items may be
          missing.
        </p>
      )}

      <div className="drive-footer">
        <span>{selectedItems.length} letters selected</span>
        <div>
          {pageTokens.length > 1 && (
            <button
              type="button"
              className="btn"
              onClick={() => setPageTokens((current) => current.slice(0, -1))}
            >
              Previous page
            </button>
          )}
          {nextPageToken && (
            <button
              type="button"
              className="btn"
              onClick={() =>
                setPageTokens((current) => [...current, nextPageToken])
              }
            >
              Next page <ArrowRight size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="drive-upload-area">
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(event) =>
            setUploadFiles(Array.from(event.target.files ?? []))
          }
        />
        <div>
          <strong>Add letters to this Drive folder</strong>
          <span>Files up to 15 MB each. Existing files are left untouched.</span>
        </div>
        <div className="drive-upload-actions">
          <button
            type="button"
            className="btn"
            onClick={() => uploadInput.current?.click()}
            disabled={uploading}
          >
            <FileText size={15} />
            Choose files
          </button>
          {uploadFiles.length > 0 && (
            <span className="drive-upload-count">
              {uploadFiles.length} selected
            </span>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => void uploadSelectedFiles()}
            disabled={!uploadFiles.length || uploading}
          >
            <Upload size={15} />
            {uploading ? "Saving to Drive…" : "Save to Drive"}
          </button>
        </div>
      </div>

      {selectedItems.length > 0 && (
        <button
          type="button"
          className="btn primary drive-review-button"
          onClick={reviewSelection}
        >
          Confirm company names from selected letters
        </button>
      )}

      {feedback && (
        <div className="message" role="status">
          {feedback}
        </div>
      )}

      {reviewOpen && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal drive-review-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drive-review-title"
          >
            <header>
              <div>
                <div className="eyebrow">FROM YOUR DRIVE</div>
                <h2 id="drive-review-title">Confirm company names</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close company name review"
                onClick={() => setReviewOpen(false)}
              >
                <X size={19} />
              </button>
            </header>
            <p className="confirm-copy">
              Names start from the file names. Preview each letter and edit the
              company name if needed. These are still unverified office
              candidates, not confirmed addresses or walk-in policies.
            </p>
            <div className="drive-review-list">
              {reviewItems.map((item) => (
                <div className="drive-review-card" key={item.id}>
                  <div className="drive-review-file">
                    <FileText size={16} />
                    <span>{item.name}</span>
                    <button
                      type="button"
                      className="drive-preview-button"
                      onClick={() => setPreviewItem(item)}
                    >
                      <Eye size={14} /> Read letter
                    </button>
                  </div>
                  <label className="field">
                    <span>Company name</span>
                    <input
                      value={
                        candidateNames[item.id] ??
                        companyNameFromFilename(item.name)
                      }
                      onChange={(event) =>
                        setCandidateNames((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setReviewOpen(false)}
              >
                Go back
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={importReviewedItems}
                disabled={reviewItems.length === 0}
              >
                <CheckCircle2 size={15} />
                Add to company list
              </button>
            </div>
          </section>
        </div>
      )}

      {previewItem && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="modal drive-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drive-preview-title"
          >
            <header>
              <div>
                <div className="eyebrow">PRIVATE DRIVE PREVIEW</div>
                <h2 id="drive-preview-title">{previewItem.name}</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close file preview"
                onClick={() => setPreviewItem(null)}
              >
                <X size={19} />
              </button>
            </header>
            <div className="drive-preview-note">
              The preview is streamed from Drive through the signed-in,
              owner-only API. If this format cannot be displayed, open it in
              Google Drive.
              {previewItem.webViewLink && (
                <a
                  href={previewItem.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Google Drive
                </a>
              )}
            </div>
            <iframe
              title={`Preview of ${previewItem.name}`}
              src={getPreviewDriveFileUrl(previewItem.id)}
              className="drive-preview-frame"
              referrerPolicy="no-referrer"
            />
          </section>
        </div>
      )}
    </section>
  );
}
