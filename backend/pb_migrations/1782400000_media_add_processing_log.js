/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.add(new JSONField({
    id: "json_processing_log",
    name: "processingLog",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.removeById("json_processing_log");
  return app.save(col);
});
