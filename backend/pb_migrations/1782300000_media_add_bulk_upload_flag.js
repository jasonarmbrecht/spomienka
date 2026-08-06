/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.add(new BoolField({ id: "bool_bulk_upload", name: "bulkUpload", required: false, system: false, hidden: false, presentable: false }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.removeById("bool_bulk_upload");
  return app.save(col);
});
