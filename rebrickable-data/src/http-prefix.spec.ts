import { RequestMethod } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GLOBAL_PREFIX, GLOBAL_PREFIX_EXCLUSIONS } from './http-prefix';

describe('prefixe global', () => {
  it('exclut health, internal et admin du prefixe /v1 - et rien d autre', () => {
    expect(GLOBAL_PREFIX).toBe('v1');
    expect(GLOBAL_PREFIX_EXCLUSIONS).toEqual([
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/(.*)', method: RequestMethod.ALL },
      { path: 'internal/(.*)', method: RequestMethod.ALL },
      { path: 'admin/(.*)', method: RequestMethod.ALL },
    ]);
  });

  it('main.ts applique bien cette liste, sans trust proxy', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(
      /setGlobalPrefix\(GLOBAL_PREFIX,\s*\{\s*exclude:\s*GLOBAL_PREFIX_EXCLUSIONS\s*\}\)/,
    );
    expect(main).not.toMatch(/app\.set\(\s*'trust proxy'/);
  });
});
