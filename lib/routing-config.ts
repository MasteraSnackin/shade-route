export type RoutingEndpointRole = "primary" | "fallback";

export interface RoutingEndpointConfig {
  url: string;
  role: RoutingEndpointRole;
  headers: Readonly<Record<string, string>>;
}

type RoutingEnvironment = Readonly<Record<string, string | undefined>>;

const DEFAULT_PRIMARY_URL = "http://127.0.0.1:8002/route";
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_PROVIDER_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "transfer-encoding",
  "x-client-id",
]);

export function isSafeRoutingEndpoint(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function providerHeaders(name: string | undefined, token: string | undefined) {
  const trimmedName = name?.trim();
  const trimmedToken = token?.trim();
  if (!trimmedName || !trimmedToken) return {};
  if (
    trimmedName.length > 100 ||
    trimmedToken.length > 2_048 ||
    !HEADER_NAME_PATTERN.test(trimmedName) ||
    FORBIDDEN_PROVIDER_HEADERS.has(trimmedName.toLowerCase())
  ) {
    return {};
  }
  return { [trimmedName]: trimmedToken };
}

export function configuredRoutingEndpoints(
  environment: RoutingEnvironment = process.env,
): RoutingEndpointConfig[] {
  const candidates: RoutingEndpointConfig[] = [
    {
      role: "primary",
      url: environment.VALHALLA_URL?.trim() || DEFAULT_PRIMARY_URL,
      headers: providerHeaders(
        environment.VALHALLA_AUTH_HEADER,
        environment.VALHALLA_AUTH_TOKEN,
      ),
    },
    ...(environment.VALHALLA_FALLBACK_URL?.trim()
      ? [{
          role: "fallback" as const,
          url: environment.VALHALLA_FALLBACK_URL.trim(),
          headers: providerHeaders(
            environment.VALHALLA_FALLBACK_AUTH_HEADER,
            environment.VALHALLA_FALLBACK_AUTH_TOKEN,
          ),
        }]
      : []),
  ];

  const seen = new Set<string>();
  return candidates.filter((endpoint) => {
    if (!isSafeRoutingEndpoint(endpoint.url) || seen.has(endpoint.url)) return false;
    seen.add(endpoint.url);
    return true;
  });
}
