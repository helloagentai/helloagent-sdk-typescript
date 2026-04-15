// Browser + Node compatible: we pre-bundle the .proto schema via pbjs so
// there is no filesystem read at runtime.
//
// The `.js` extension + `@ts-ignore` sidesteps the fact that the generated
// bundle is untyped JS; Envelope.encode/decode have runtime types we supply
// via the `any` return on decode.
// @ts-ignore — generated JS module has no bundled .d.ts
import root from "./proto-bundle.js";

export const Envelope = root.lookupType("helloagent.v1.Envelope");
const roleEnum = root.lookupEnum("helloagent.v1.Role");
export const Role = roleEnum.values as {
  ROLE_UNSPECIFIED: number;
  ROLE_USER: number;
  ROLE_AGENT: number;
};

export function encode(payload: object): Uint8Array {
  const msg = Envelope.create(payload);
  return Envelope.encode(msg).finish();
}

export function decode(data: Uint8Array): any {
  return Envelope.decode(data).toJSON();
}
