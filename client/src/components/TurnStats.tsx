import { ChevronDown } from 'lucide-react';
import { modelLabel, tokenSpeed, turnDuration, type TurnStats } from '../chat';

const LANES: { key: keyof TurnStats['lanes']; label: string }[] = [
  { key: 'brain', label: 'Мозг' },
  { key: 'talk', label: 'Разговор' },
  { key: 'memory', label: 'Память' },
  { key: 'vision', label: 'Зрение' },
];

export function TurnStatsView({ stats }: { stats: TurnStats }) {
  const lanes = LANES.filter((lane) => stats.lanes[lane.key]);
  if (!lanes.length) return null;
  const model = modelLabel(stats.model);
  const speed = tokenSpeed(stats.tokens_per_second);
  return (
    <div className="turn-stats">
      {model && <span className="turn-model" title={stats.model}>{model}</span>}
      {model && <span aria-hidden="true">·</span>}
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
                <span>{lane.label}</span>
                <span>
                  {turnDuration(item.duration_ms)}
                  {item.calls > 1 ? ` · ${item.calls} вызова` : ''}
                </span>
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
}
