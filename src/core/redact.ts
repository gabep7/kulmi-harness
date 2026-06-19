export function redactKnownSecrets(value: string): string;
export function redactKnownSecrets<T>(value: T): T;
export function redactKnownSecrets<T>(value: T): T {
  const secrets = knownSecrets();
  return redactValue(value, secrets);
}

function knownSecrets(): Array<[string, string]> {
  return Object.entries(process.env)
    .filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" &&
      entry[1].length >= 8 &&
      /(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/i.test(entry[0])
    )
    .sort((left, right) => right[1].length - left[1].length);
}

function redactValue<T>(value: T, secrets: Array<[string, string]>): T {
  if (typeof value === "string") {
    let output: string = value;
    for (const [name, secret] of secrets) output = output.replaceAll(secret, `[redacted:${name}]`);
    return output as T;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]),
    ) as T;
  }
  return value;
}
