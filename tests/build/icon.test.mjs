import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the canonical companion icon is a 512px RGB PNG", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  assert.equal(manifest.icon, "images/icon.png");

  const png = fs.readFileSync("images/icon.png");

  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.equal(png.toString("ascii", 12, 16), "IHDR");
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 512);
  assert.equal(png[24], 8);
  assert.ok(png[25] === 2 || png[25] === 6, "Icon must be RGB or RGBA.");
});
