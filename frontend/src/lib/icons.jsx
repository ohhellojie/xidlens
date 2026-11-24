import React from 'react';

const PATHS = {
  devices: 'M3 5a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 5v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 9V5Zm0 10a1.5 1.5 0 0 1 1.5-1.5h15A1.5 1.5 0 0 1 21 15v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19v-4ZM7 7h.01M7 17h.01',
  errors: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v4M12 16h.01',
  topology: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
  compare: 'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
  log: 'M4 6h16M4 12h16M4 18h10',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.35-4.35',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
  refresh: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  close: 'M18 6 6 18M6 6l12 12',
  copy: 'M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  chevron: 'm9 18 6-6-6-6',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`xl-icon ${className}`}
    >
      <path d={PATHS[name] || PATHS.file} />
    </svg>
  );
}
