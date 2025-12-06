import PocketBase from "pocketbase";

const pbUrl = import.meta.env.VITE_PB_URL;
export const pb = new PocketBase(pbUrl);

