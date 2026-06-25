/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.add(new TextField({ id: "text_camera_make", name: "cameraMake", required: false, system: false, hidden: false, presentable: false }));
  col.fields.add(new TextField({ id: "text_camera_model", name: "cameraModel", required: false, system: false, hidden: false, presentable: false }));
  col.fields.add(new TextField({ id: "text_focal_length", name: "focalLength", required: false, system: false, hidden: false, presentable: false }));
  col.fields.add(new TextField({ id: "text_f_number", name: "fNumber", required: false, system: false, hidden: false, presentable: false }));
  col.fields.add(new TextField({ id: "text_exposure_time", name: "exposureTime", required: false, system: false, hidden: false, presentable: false }));
  col.fields.add(new TextField({ id: "text_iso", name: "iso", required: false, system: false, hidden: false, presentable: false }));
  return app.save(col);
}, (app) => {
  const col = app.findCollectionByNameOrId("media");
  col.fields.removeById("text_camera_make");
  col.fields.removeById("text_camera_model");
  col.fields.removeById("text_focal_length");
  col.fields.removeById("text_f_number");
  col.fields.removeById("text_exposure_time");
  col.fields.removeById("text_iso");
  return app.save(col);
});
