import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export default function SearchField({ placeholder, value, onChange, onSelect, dotClass, region, busy }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const skipNext = useRef(false);

  useEffect(() => {
    // Bir öneri seçildiğinde metin değişir; bunu yeni arama sanmamalıyız
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    if (!value || value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const handle = setTimeout(() => {
      api
        .geocode(value, region)
        .then((d) => setSuggestions(d.results || []))
        .catch(() => setSuggestions([]));
    }, 350);
    return () => clearTimeout(handle);
  }, [value, region]);

  const choose = (s) => {
    skipNext.current = true;
    onSelect(s);
    setOpen(false);
    setSuggestions([]);
    setHighlight(-1);
  };

  const onKeyDown = (e) => {
    if (!open || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" && highlight >= 0) {
      e.preventDefault();
      choose(suggestions[highlight]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="search-field">
      <span className={`dot ${dotClass}`} aria-hidden="true" />
      <input
        type="text"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {busy && <span className="field-spinner" aria-hidden="true" />}
      {value && !busy && (
        <button
          className="field-clear"
          aria-label="Temizle"
          onMouseDown={(e) => {
            e.preventDefault();
            onChange("");
            onSelect(null);
          }}
        >
          ×
        </button>
      )}
      {open && suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s, i) => (
            <li
              key={i}
              role="option"
              aria-selected={i === highlight}
              className={i === highlight ? "active" : ""}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
