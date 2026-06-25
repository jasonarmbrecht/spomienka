/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.add(new TextField({
    id: "text_description",
    name: "description",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  col.fields.add(new TextField({
    id: "text_location",
    name: "location",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
  }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.removeById("text_description");
  col.fields.removeById("text_location");
  return app.save(col);
});
