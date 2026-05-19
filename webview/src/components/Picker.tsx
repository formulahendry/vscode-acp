import type { JSX, MouseEvent as ReactMouseEvent } from 'react';

export type PickerProps<T> = {
  label: string;
  title: string;
  icon: string;
  currentValue: string | null;
  items: T[];
  itemKey: (item: T) => string;
  itemLabel: (item: T) => string;
  itemDescription: (item: T) => string | undefined;
  isOpen: boolean;
  onToggle: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSelect: (item: T, event: ReactMouseEvent<HTMLDivElement>) => void;
};

export function Picker<T>({
  label,
  title,
  icon,
  currentValue,
  items,
  itemKey,
  itemLabel,
  itemDescription,
  isOpen,
  onToggle,
  onSelect,
}: PickerProps<T>): JSX.Element {
  return (
    <div className="picker-wrap" onClick={(event) => event.stopPropagation()}>
      <button className="picker-btn" title={title} type="button" onClick={onToggle}>
        <span className="picker-icon">{icon}</span>
        <span className="picker-label">{label}</span>
        <span className="picker-chevron">▾</span>
      </button>
      <div className={`picker-dropdown${isOpen ? ' open' : ''}`}>
        {items.map((item) => {
          const key = itemKey(item);
          const selected = key === currentValue;
          return (
            <div
              className={`picker-dropdown-item${selected ? ' selected' : ''}`}
              key={key}
              onClick={(event) => onSelect(item, event)}
            >
              <span className="check">{selected ? '✓' : ''}</span>
              <span className="item-label">{itemLabel(item)}</span>
              {itemDescription(item) ? <span className="item-desc">{itemDescription(item)}</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
