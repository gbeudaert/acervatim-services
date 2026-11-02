import { HttpMethod, ROUTE_TABLE, RouteRule } from './route-table';

export interface RouteMatch {
  rule: RouteRule;
  /** Parametres nommes extraits du chemin (`:id` -> valeur), deja decodes. */
  params: Record<string, string>;
}

/**
 * Appariement chemin -> regle. Volontairement minimal plutot que base sur `path-to-regexp` :
 * la table ne contient que des segments litteraux et des `:params` d'un seul segment, et une
 * dependance de plus sur le chemin le plus chaud du systeme ne s'amortirait pas.
 *
 * Deux garde-fous qui comptent :
 * - la comparaison se fait **segment par segment** ; aucune expression reguliere ne voit le
 *   chemin brut, donc aucun risque qu'un chemin construit fasse deraper un quantificateur ;
 * - un `:param` ne capture **jamais** un segment vide, sans quoi `/v1/items//sources`
 *   matcherait `/v1/items/:id/sources` avec un identifiant vide et partirait en aval.
 */
export function matchRoute(
  method: string,
  path: string,
): RouteMatch | undefined {
  const upper = method.toUpperCase() as HttpMethod;
  const segments = splitPath(path);

  for (const rule of ROUTE_TABLE) {
    if (!rule.methods.includes(upper)) continue;
    const params = matchSegments(splitPath(rule.pattern), segments);
    if (params) return { rule, params };
  }
  return undefined;
}

/**
 * Existe-t-il une regle pour ce chemin, quelle que soit la methode ? Sert a distinguer un
 * `405` d'un `404` : une route connue appelee avec le mauvais verbe n'est pas une route
 * inconnue, et repondre 404 aux deux rendrait toute erreur de client indiscernable d'une
 * faute de frappe.
 */
export function pathExists(path: string): boolean {
  const segments = splitPath(path);
  return ROUTE_TABLE.some((rule) =>
    Boolean(matchSegments(splitPath(rule.pattern), segments)),
  );
}

/** Methodes acceptees pour ce chemin - le contenu de l'en-tete `Allow` d'un 405. */
export function allowedMethods(path: string): HttpMethod[] {
  const segments = splitPath(path);
  const methods = new Set<HttpMethod>();
  for (const rule of ROUTE_TABLE) {
    if (matchSegments(splitPath(rule.pattern), segments)) {
      for (const m of rule.methods) methods.add(m);
    }
  }
  return [...methods];
}

/**
 * Decoupe un chemin en segments, **en conservant les segments vides internes**.
 *
 * Le detail compte : filtrer tous les vides ferait de `/v1/items//sources` la meme chose que
 * `/v1/items/sources`, qui matche `/v1/items/:id` avec `id = "sources"`. Une URL malformee
 * partirait alors en aval avec un identifiant invente - c'est-a-dire un `404` sur une
 * ressource qui n'a jamais ete demandee, et une trace incomprehensible.
 *
 * On ne retire donc que les vides de bord : celui du `/` initial, et celui d'un `/` final -
 * `/v1/collections/` reste `/v1/collections`.
 */
function splitPath(path: string): string[] {
  const segments = path.split('?')[0].split('/');
  if (segments[0] === '') segments.shift();
  if (segments.length > 0 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  return segments;
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      // Un segment vide n'est pas une valeur : `//` ne doit pas devenir un identifiant.
      if (actual[i].length === 0) return undefined;
      params[p.slice(1)] = safeDecode(actual[i]);
      continue;
    }
    if (p !== actual[i]) return undefined;
  }
  return params;
}

/** Un `%` isole dans une URL ne doit pas faire lever le routeur : on garde le brut. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
