/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("devices");
  col.fields.add(new JSONField({
    id: "json_telemetry",
    name: "telemetry",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("devices");
  col.fields.removeById("json_telemetry");
  return app.save(col);
});
