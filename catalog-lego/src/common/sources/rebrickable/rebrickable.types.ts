export const REBRICKABLE_QUEUE = 'rebrickable';

/**
 * Un seul type de job : « appelle cette URL avec cette cle ». Le parsing et la mise en cache
 * restent cote service, comme pour la BnF du monolithe - le worker n'est qu'un robinet de debit.
 */
export interface RebrickableFetchJobData {
  url: string;
  apiKey: string;
}

export interface RebrickableSet {
  set_num: string;
  name: string;
  year: number | null;
  theme_id: number | null;
  num_parts: number | null;
  set_img_url: string | null;
  set_url?: string | null;
  last_modified_dt?: string | null;
}

export interface RebrickableTheme {
  id: number;
  parent_id: number | null;
  name: string;
}

export interface RebrickablePage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}
