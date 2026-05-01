import { readFileSync, writeFileSync } from "node:fs";

const path = "src/proto-bundle.js";
let src = readFileSync(path, "utf8");

// Two patches, applied in order so the script tolerates both pbjs v1
// (`import * as $protobuf from "protobufjs/light";`) and pbjs v2
// (`import $protobuf from "protobufjs/light";`):
//
//   1. Convert CJS-namespace import to default import (collapses v1 → v2).
//   2. Append `.js` to the subpath. protobufjs has no exports map, so
//      NodeNext ESM resolution requires the explicit extension.
src = src.replace(
  /import \* as \$protobuf from "protobufjs\/light";/,
  `import $protobuf from "protobufjs/light";`,
);
src = src.replace(
  /import \$protobuf from "protobufjs\/light";/,
  `import $protobuf from "protobufjs/light.js";`,
);

writeFileSync(path, src);
console.log("[patch-bundle] ok");
