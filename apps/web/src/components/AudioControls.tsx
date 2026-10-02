import { useId } from "react";

export function AudioLevelControl({ label, value, max = 200, onChange }: { label: string; value: number; max?: number; onChange: (value: number) => void }) {
  return (
    <label className="audio-level-control">
      <span><span>{label}</span><strong>{value}%</strong></span>
      <input aria-label={label} type="range" min="0" max={max} step="1" value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </label>
  );
}

export function AudioSwitchControl({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const labelId = useId();
  return (
    <div className="audio-toggle-control">
      <span id={labelId}>{label}</span>
      <button
        className={`audio-switch ${checked ? "is-on" : ""}`}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        onClick={() => onChange(!checked)}
      ><span aria-hidden="true" /></button>
      {hint ? <span className="muted small">{hint}</span> : null}
    </div>
  );
}

