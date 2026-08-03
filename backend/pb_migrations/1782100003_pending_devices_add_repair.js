/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("pending_devices");
  col.fields.add(new TextField({
    id: "pd_repair",
    name: "repairDeviceId",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("pending_devices");
  col.fields.removeById("pd_repair");
  return app.save(col);
});
