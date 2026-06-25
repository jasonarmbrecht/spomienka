/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("device_inbox");
  col.fields.add(new JSONField({
    id: "json_payload",
    name: "payload",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("device_inbox");
  col.fields.removeById("json_payload");
  return app.save(col);
});
