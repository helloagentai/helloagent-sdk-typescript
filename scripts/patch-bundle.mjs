import { readFileSync, writeFileSync } from "node:fs";

const path = "src/proto-bundle.js";
let src = readFileSync(path, "utf8");

// Convert CJS-namespace import to default import so interop works under
// Node ESM + browsers with bundlers. Also add a .js extension so NodeNext
// can resolve the subpath (protobufjs has no exports map for /light).
src = src.replace(
  /import \* as \$protobuf from "protobufjs\/light";/,
  `import $protobuf from "protobufjs/light.js";`
);

writeFileSync(path, src);
console.log("[patch-bundle] ok");
