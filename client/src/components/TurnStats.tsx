import { ChevronDown } from 'lucide-react';
import { callsLabel, modelLabel, tokenSpeed, turnDuration, type TurnStats } from '../chat';

const LANES: { key: keyof TurnStats['lanes']; label: string }[] = [
  { key: 'brain', label: 'Мозг' },
  { key: 'talk', label: 'Разговор' },
  { key: 'memory', label: 'Память' },
  { key: 'vision', label: 'Зрение' },
];

export function TurnStatsView({ stats }: { stats: TurnStats }) {
  if (!stats || typeof stats.duration_ms !== 'number' || !stats.lanes || typeof stats.lanes !== 'object') return null;
  const lanes = LANES.filter((lane) => stats.lanes[lane.key]);
  if (!lanes.length) return null;
  const speed = tokenSpeed(stats.tokens_per_second);
  return (
    <div className="turn-stats">
      <span>{turnDuration(stats.duration_ms)}</span>
      {speed && <span aria-hidden="true">·</span>}
      {speed && <span>{speed}</span>}
      <details>
        <summary>
          Использовано
          <ChevronDown size={11} aria-hidden="true" />
        </summary>
        <div className="turn-lanes">
          {lanes.map((lane) => {
            const item = stats.lanes[lane.key]!;
            return (
              <div key={lane.key}>
                <span className="turn-lane-name">
                  <span>{lane.label}</span>
                  {item.model && <span className="turn-lane-model" title={item.model}>{modelLabel(item.model)}</span>}
                </span>
                <span>
                  {turnDuration(item.duration_ms)}
                  {item.calls > 1 ? ` · ${callsLabel(item.calls)}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
