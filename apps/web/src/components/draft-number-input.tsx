'use client';

import { useEffect, useState, type InputHTMLAttributes } from 'react';

/**
 * #298 / #296: a number input that keeps the typed text as a local draft and only commits values
 * inside [min, max]. Clearing the field or typing the first digit of a new value (for example "1"
 * on the way to "18") therefore never writes an out-of-range number into the storyboard, where the
 * schema parsers would throw during rendering. Leaving the field restores the last valid value.
 */
export function DraftNumberInput({ value, min, max, onCommit, allowEmpty = false, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'min' | 'max' | 'onChange' | 'type'> & {
  value: number | undefined;
  min: number;
  max: number;
  onCommit: (value: number | undefined) => void;
  /** When true an empty field commits `undefined` ("不修改"). */
  allowEmpty?: boolean;
}) {
  const shown = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);
  return <input
    {...rest}
    type="number"
    min={min}
    max={max}
    value={draft}
    onChange={event => {
      const text = event.target.value;
      setDraft(text);
      if (text.trim() === '') { if (allowEmpty) onCommit(undefined); return; }
      const next = Number(text);
      if (Number.isFinite(next) && next >= min && next <= max) onCommit(next);
    }}
    onBlur={event => { setDraft(shown); rest.onBlur?.(event); }}
  />;
}
