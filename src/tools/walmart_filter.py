"""Filters the Walmart paid history workbook: for each sheet asked, the rows whose date column falls in [from, to], as a csv.

usage: walmart_filter.py BOOK OUT_DIR "236, 450" "Date Paid" FROM TO   -> prints JSON: [{sheet, rows, total, file}]
The workbook runs to hundreds of thousands of rows, so each sheet is read once, with calamine where it's installed (several times
faster than openpyxl).
"""
import json, sys
from pathlib import Path
import pandas as pd

try:
    import python_calamine  # noqa: F401
    ENGINE = 'calamine'
except ImportError:
    ENGINE = 'openpyxl'

book, out, sheets, column, start, end = sys.argv[1:7]
wanted = [s.strip() for s in sheets.split(',') if s.strip()]
xl = pd.ExcelFile(book, engine=ENGINE)
names = {n.strip().lower(): n for n in xl.sheet_names}
result = []
for sheet in wanted:
    name = names.get(sheet.lower())
    if name is None:
        sys.exit(f'no sheet "{sheet}"; the workbook has {", ".join(xl.sheet_names)}')
    raw = xl.parse(name, header=None, dtype=object)
    # The header is the first row that names the date column, as reports often carry a title above it.
    at = next((i for i in range(min(len(raw), 20)) if any(str(v).strip().lower() == column.lower() for v in raw.iloc[i].values)), None)
    if at is None:
        sys.exit(f'sheet "{name}" has no "{column}" column in its first 20 rows')
    frame = raw.iloc[at + 1:].copy()
    frame.columns = [str(c).strip() for c in raw.iloc[at].values]
    frame = frame.dropna(how='all')
    col = next(c for c in frame.columns if c.lower() == column.lower())
    dates = pd.to_datetime(frame[col], errors='coerce')
    keep = frame[(dates >= pd.Timestamp(start)) & (dates < pd.Timestamp(end) + pd.Timedelta(days=1))].copy()
    # Dates without a time of day are written as plain dates.
    day = lambda v: v.strftime('%Y-%m-%d') if hasattr(v, 'strftime') and (v.hour, v.minute, v.second) == (0, 0, 0) else v
    for c in keep.columns:
        keep[c] = keep[c].map(day)
    path = Path(out) / f'{sheet}.csv'
    keep.to_csv(path, index=False, encoding='utf-8-sig', date_format='%Y-%m-%d')
    result.append({'sheet': sheet, 'rows': len(keep), 'total': len(frame), 'file': str(path)})
print(json.dumps(result))
