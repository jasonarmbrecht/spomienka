/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    name: "device_inbox",
    type: "base",
    fields: [
      {
        "id": "text_device_id",
        "name": "device_id",
        "type": "text",
        "required": true,
        "system": false,
        "hidden": false,
        "presentable": false,
        "primaryKey": false,
        "autogeneratePattern": "",
        "min": 0,
        "max": 0,
        "pattern": ""
      },
      {
        "id": "text_type",
        "name": "type",
        "type": "text",
        "required": false,
        "system": false,
        "hidden": false,
        "presentable": false,
        "primaryKey": false,
        "autogeneratePattern": "",
        "min": 0,
        "max": 0,
        "pattern": ""
      }
    ],
    // Public read so the viewer can subscribe via realtime without admin auth.
    // Only admins can create/delete — these are ephemeral command signals.
    viewRule: "",
    listRule: "",
    createRule: "@request.auth.role = 'admin'",
    updateRule: null,
    deleteRule: "@request.auth.role = 'admin'",
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("device_inbox");
  return app.delete(collection);
});
