import { FormEvent, useState } from "react";
import { pb } from "../pb/client";
import { useAuth } from "../pb/auth";

export function UploadPage() {
  const { user } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setStatus("Uploading...");
    setError(null);
    const form = new FormData();
    form.append("file", file);
    form.append("type", file.type.startsWith("video/") ? "video" : "image");
    form.append("status", user?.role === "admin" ? "published" : "pending");
    form.append("owner", user?.id ?? "");
    try {
      await pb.collection("media").create(form);
      setStatus("Uploaded");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus(null);
    }
  };

  return (
    <section>
      <h1>Upload</h1>
      <form onSubmit={onSubmit}>
        <input
          type="file"
          accept="image/*,video/*"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button type="submit" disabled={!file}>Upload</button>
      </form>
      {status && <p>{status}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

