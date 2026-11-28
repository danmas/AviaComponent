/**
 * Каркас трёх экранов. Сессия создаётся здесь один раз.
 * Цех, свод и разбор только переключают вид.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { client } from './lib/api.ts';
import { screenParams, type ScreenParams } from './lib/params.ts';
import { followServer, openScreen, viewShift, type PlayState, type ScreenId } from './lib/session.ts';
import { DashboardScreen } from './screens/DashboardScreen.tsx';
import { ReviewScreen } from './screens/ReviewScreen.tsx';
import { ShopScreen } from './screens/ShopScreen.tsx';

export function App(): JSX.Element {
  const params = useMemo(() => screenParams(), []);
  const [play, setPlay] = useState<PlayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playRef = useRef<PlayState | null>(null);
  playRef.current = play;

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const created = await client.createSession({
          seed: params.seed,
          level: params.level,
          overlay: params.overlay,
        });
        let shift = 0;
        for (let step = 0; step < params.shift; step += 1) {
          const advanced = await client.advance(created.id);
          shift = advanced.currentShift;
        }
        if (!alive) {
          return;
        }
        setPlay({
          sessionId: created.id,
          viewShift: shift,
          serverShift: shift,
          shiftCount: created.horizonShifts,
          screen: params.view,
        });
      } catch (caught: unknown) {
        if (alive) {
          setError(caught instanceof Error ? caught.message : 'Сервер недоступен');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [params]);

  async function step(): Promise<void> {
    const current = playRef.current;
    if (current === null) {
      return;
    }
    const advanced = await client.advance(current.sessionId);
    setPlay(followServer(current, advanced.currentShift));
  }

  function select(screen: ScreenId): void {
    setPlay((current) => (current === null ? current : openScreen(current, screen)));
  }

  function show(shift: number): void {
    setPlay((current) => (current === null ? current : viewShift(current, shift)));
  }

  if (play === null) {
    return (
      <div className="sheet">
        <h1>{error === null ? 'Считаем срез…' : 'Цех недоступен'}</h1>
        {error !== null ? <p className="ink-faint">{error}</p> : null}
      </div>
    );
  }

  const shared = { play, params, onScreen: select, onStep: step, onView: show };
  if (play.screen === 'dashboard') {
    return <DashboardScreen {...shared} />;
  }
  if (play.screen === 'review') {
    return <ReviewScreen {...shared} />;
  }
  return <ShopScreen {...shared} />;
}

export type { ScreenParams };
