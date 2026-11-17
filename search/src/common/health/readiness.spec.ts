import {
  READINESS_TIMEOUT_MS,
  readinessHttpStatus,
  readinessStatus,
  withDeadline,
} from './readiness';

describe('withDeadline', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rend le resultat quand la dependance repond a temps', async () => {
    await expect(withDeadline(Promise.resolve(42))).resolves.toBe(42);
  });

  it("propage l'echec de la dependance sans attendre le delai", async () => {
    await expect(
      withDeadline(Promise.reject(new Error('base injoignable'))),
    ).rejects.toThrow('base injoignable');
  });

  it('rejette au bout du delai quand la dependance ne repond jamais', async () => {
    jest.useFakeTimers();
    const outcome = jest.fn();
    // Une promesse qui ne se regle jamais : la base accepte la connexion puis se tait.
    void withDeadline(new Promise<number>(() => undefined)).catch(outcome);

    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS - 1);
    expect(outcome).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledTimes(1);
    expect((outcome.mock.calls[0][0] as Error).message).toContain(
      `${READINESS_TIMEOUT_MS} ms`,
    );
  });

  it('libere son minuteur des que la dependance a repondu', async () => {
    jest.useFakeTimers();
    await withDeadline(Promise.resolve('ok'));
    expect(jest.getTimerCount()).toBe(0);

    await withDeadline(Promise.reject(new Error('x'))).catch(() => undefined);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('readinessStatus', () => {
  it.each([
    [true, true, 'ok'],
    [true, false, 'degraded'],
    [false, true, 'unavailable'],
    [false, false, 'unavailable'],
  ] as const)('vital=%s secondary=%s -> %s', (vital, secondary, expected) => {
    expect(readinessStatus(vital, secondary)).toBe(expected);
  });

  it('sans dependance secondaire, seul le vital compte', () => {
    expect(readinessStatus(true)).toBe('ok');
    expect(readinessStatus(false)).toBe('unavailable');
  });
});

describe('readinessHttpStatus', () => {
  it('503 quand une dependance vitale manque, 200 sinon', () => {
    expect(readinessHttpStatus('ok')).toBe(200);
    expect(readinessHttpStatus('degraded')).toBe(200);
    expect(readinessHttpStatus('unavailable')).toBe(503);
  });
});
