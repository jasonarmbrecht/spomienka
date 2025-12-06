import PocketBase from "pocketbase";

const pbUrl = import.meta.env.VITE_PB_URL;

if (!pbUrl) {
  if (import.meta.env.DEV) {
    console.warn(
      "VITE_PB_URL is not set. Please set it in your .env file or environment variables."
    );
  }
  throw new Error(
    "VITE_PB_URL environment variable is required. Please set it to your PocketBase URL (e.g., http://localhost:8090)"
  );
}

export const pb = new PocketBase(pbUrl);

