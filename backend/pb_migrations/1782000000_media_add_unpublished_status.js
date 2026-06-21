/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("media");
  const field = collection.fields.getByName("status");
  if (field && field.values && !field.values.includes("unpublished")) {
    field.values.push("unpublished");
    return app.save(collection);
  }
}, (app) => {
  const collection = app.findCollectionByNameOrId("media");
  const field = collection.fields.getByName("status");
  if (field && field.values) {
    field.values = field.values.filter((v) => v !== "unpublished");
    return app.save(collection);
  }
});
