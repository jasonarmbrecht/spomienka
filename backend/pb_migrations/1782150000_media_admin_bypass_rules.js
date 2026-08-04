/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = app.findCollectionByNameOrId("media");
  collection.listRule = "status = 'published' || @request.auth.role = 'admin'";
  collection.viewRule = "status = 'published' || @request.auth.role = 'admin'";
  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("media");
  collection.listRule = "status = 'published'";
  collection.viewRule = "status = 'published'";
  return app.save(collection);
});
