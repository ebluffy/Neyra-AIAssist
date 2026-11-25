UPDATE "user"
SET name = split_part(btrim(email), '@', 1)
WHERE btrim(email) <> ''
  AND (name IS NULL OR btrim(name) = '' OR lower(btrim(name)) = lower(btrim(email)));
