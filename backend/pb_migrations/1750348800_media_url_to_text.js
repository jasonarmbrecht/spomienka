/// <reference path="../pb_data/types.d.ts" />
// Change displayUrl, blurUrl, thumbUrl, videoUrl, posterUrl from url → text.
// These fields store internal /api/files/... paths, not external URLs.
// PocketBase's url validator requires http:// or https:// and rejects relative paths.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("media");

  const fields = ["f_disp", "f_blur", "f_thumb", "f_video", "f_poster"];
  for (const id of fields) {
    const field = collection.fields.getById(id);
    if (field) field.type = "text";
  }

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("media");

  const fields = ["f_disp", "f_blur", "f_thumb", "f_video", "f_poster"];
  for (const id of fields) {
    const field = collection.fields.getById(id);
    if (field) field.type = "url";
  }

  return app.save(collection);
});
