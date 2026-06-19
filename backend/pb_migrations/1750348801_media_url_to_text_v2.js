/// <reference path="../pb_data/types.d.ts" />
// PocketBase 0.25 rejects field type changes via the schema API ("Field type cannot
// be changed"). Work around it with a direct SQL update on the _collections JSON.
// Targets only the five URL fields by id so other url-type fields are untouched.
migrate((app) => {
  app.db().newQuery(`
    UPDATE _collections
    SET fields = (
      SELECT json_group_array(
        CASE
          WHEN json_extract(j.value, '$.id') IN ('f_disp','f_blur','f_thumb','f_video','f_poster')
          THEN json_set(j.value, '$.type', 'text')
          ELSE j.value
        END
      )
      FROM json_each((SELECT fields FROM _collections WHERE name = 'media')) AS j
    )
    WHERE name = 'media'
  `).execute();
}, (app) => {
  app.db().newQuery(`
    UPDATE _collections
    SET fields = (
      SELECT json_group_array(
        CASE
          WHEN json_extract(j.value, '$.id') IN ('f_disp','f_blur','f_thumb','f_video','f_poster')
          THEN json_set(j.value, '$.type', 'url')
          ELSE j.value
        END
      )
      FROM json_each((SELECT fields FROM _collections WHERE name = 'media')) AS j
    )
    WHERE name = 'media'
  `).execute();
});
