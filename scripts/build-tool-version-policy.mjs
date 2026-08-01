export const OFFICIAL_RELEASE_NODE_VERSION = "v26.5.0";
export const OFFICIAL_RELEASE_UV_VERSION = "0.12.0";

const stableTriplet = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)";

export function assertSupportedNodeVersion(value) {
  const match = new RegExp(`^v${stableTriplet}$`).exec(value);
  if (match === null || Number(match[1]) !== 26 || Number(match[2]) < 5) {
    throw new Error(
      `Node.js builds require >=26.5.0 <27.0.0; found ${String(value)}.`,
    );
  }
  return value;
}

export function assertSupportedUvVersionOutput(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  const match = new RegExp(
    `^uv ${stableTriplet}(?: \\([^()\\r\\n]+\\))?$`,
  ).exec(normalized);
  if (match === null || Number(match[1]) !== 0 || Number(match[2]) !== 12) {
    throw new Error(
      `Launcher builds require uv >=0.12.0 <0.13.0; found ${String(value)}.`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}
