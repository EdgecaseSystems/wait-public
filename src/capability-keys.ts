type CapabilityKeyEnvironment = Pick<Env, "CAPABILITY_KEY_V1" | "CAPABILITY_KEY_V2">;

export function resolveCapabilityKey(env: CapabilityKeyEnvironment, version: number): Uint8Array {
  let value: string | undefined;
  if (version === 1) value = env.CAPABILITY_KEY_V1;
  else if (version === 2) value = env.CAPABILITY_KEY_V2;
  else throw new Error("capability_key_version_unavailable");

  if (!value || !/^[0-9a-f]{64}$/u.test(value)) throw new Error("capability_key_unavailable");
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function selectCapabilityKey(env: CapabilityKeyEnvironment): { version: number; key: Uint8Array } {
  // Only an absent V2 selects V1; malformed configuration must fail closed.
  const version = env.CAPABILITY_KEY_V2 === undefined ? 1 : 2;
  return { version, key: resolveCapabilityKey(env, version) };
}
