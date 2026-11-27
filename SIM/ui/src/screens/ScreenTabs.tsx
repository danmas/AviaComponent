import type { ScreenId } from '../lib/session.ts';
import { tabsOf } from '../lib/session.ts';

/** Закладки цеха и свода. Текущая подсвечена, обе всегда на месте. */
export function ScreenTabs(props: {
  readonly screen: ScreenId;
  readonly onScreen: (screen: ScreenId) => void;
}): JSX.Element {
  return (
    <nav className="tabs" aria-label="экраны">
      {tabsOf(props.screen).map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={tab.active ? 'active' : ''}
          aria-current={tab.active ? 'page' : undefined}
          onClick={() => props.onScreen(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
