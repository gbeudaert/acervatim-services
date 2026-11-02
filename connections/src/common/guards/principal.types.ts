/**
 * Identite resolue d'un appelant. C'est le contrat de l'en-tete `X-Acervatim-Principal`
 * decrit en 3.6 de ../acervatim-docs/agent/backend/architecture-microservices.md : le
 * gateway verifie le JWT UNE fois, resout le premium aupres de `billing`, et propage
 * le resultat signe. Les services aval ne re-resolvent rien.
 */
export interface Principal {
  userId: string;
  /** Statut premium, resolu en amont. `false` en mode autonome (aucun `billing` joignable). */
  premium: boolean;
  /** Role sur la ressource visee, quand le gateway l'a resolu aupres de `sharing`. */
  role?: 'owner' | 'shared';
  /** Statuts d'items visibles pour un partage recu. Jamais renseigne par le client. */
  statuses?: string[];
  /** Expiration epoch-seconds du principal (TTL court cote gateway). */
  exp: number;
  /** Comment l'identite a ete etablie - sert au diagnostic, jamais a une decision metier. */
  origin: 'gateway' | 'jwt';
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
    principal?: Principal;
  }
}

export const PRINCIPAL_HEADER = 'x-acervatim-principal';
