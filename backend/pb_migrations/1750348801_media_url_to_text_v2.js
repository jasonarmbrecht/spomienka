/// <reference path="../pb_data/types.d.ts" />
// Re-attempt url→text migration using the correct removeById+addAt pattern.
// The previous migration (1750348800) used field.type = "text" which does not
// mutate the underlying Go struct and had no effect.
migrate((app) => {
  const collection = app.findCollectionByNameOrId("media");

  const fields = [
    { id: "f_disp",   name: "displayUrl" },
    { id: "f_blur",   name: "blurUrl" },
    { id: "f_thumb",  name: "thumbUrl" },
    { id: "f_video",  name: "videoUrl" },
    { id: "f_poster", name: "posterUrl" },
  ];

  for (const { id, name } of fields) {
    collection.fields.removeById(id);
    collection.fields.add(new Field({
      "hidden": false,
      "id": id,
      "max": 0,
      "min": 0,
      "name": name,
      "pattern": "",
      "presentable": false,
      "primaryKey": false,
      "required": false,
      "system": false,
      "type": "text",
    }));
  }

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("media");

  const fields = [
    { id: "f_disp",   name: "displayUrl" },
    { id: "f_blur",   name: "blurUrl" },
    { id: "f_thumb",  name: "thumbUrl" },
    { id: "f_video",  name: "videoUrl" },
    { id: "f_poster", name: "posterUrl" },
  ];

  for (const { id, name } of fields) {
    collection.fields.removeById(id);
    collection.fields.add(new Field({
      "exceptDomains": [],
      "hidden": false,
      "id": id,
      "name": name,
      "onlyDomains": [],
      "presentable": false,
      "required": false,
      "system": false,
      "type": "url",
    }));
  }

  return app.save(collection);
});
