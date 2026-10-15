"""Make a made-up weekly borrowing base series: each week's inputs, the report that was sent, the sources the agent
fetches from 08-16 on, and truth.json for scoring.

Usage: .venv/bin/python demo/make_demo.py demo/out   (needs the internet for the ECB rates)

Weeks to 07-26 are examples. 08-02 is a plain forward week. 08-09 has traps: a wrong inventory file replaced mid-run,
the card file arriving late, and the reviewer raising the availability block to 750,000, answered as a standing rule.
From 08-16 the inventory comes from a warehouse database, the lender's loan activity by email, and one customer is billed
in EUR at the ECB reference rate. 08-23's email arrives late. 08-30's warehouse snapshot is stale, and a lender email
raises one customer's concentration limit for that week only.
"""
import csv, datetime as dt, json, random, sys, urllib.request
from email.message import EmailMessage
from pathlib import Path
from openpyxl import Workbook

OUT = Path(sys.argv[1])
WEEKS = ['2026-07-05', '2026-07-12', '2026-07-19', '2026-07-26', '2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30']
TRAP, SOURCED, STALE = '2026-08-09', '2026-08-16', '2026-08-30'
CUSTOMERS = ['Ashgrove Home', 'Bellweather Kitchen', 'Cobalt & Clay', 'Dunmore Interiors', 'Eastbay Living', 'Fernhill Supply',
             'Glenrock Home Centers', 'Hollis & Pine', 'Ironbridge Hardware', 'Jasper Lane', 'Keystone Kitchens', 'Linden Hall',
             'Marlow Mercantile', 'Newfield Home', 'Orchard & Oak', 'Pembrook Stores', 'Quarry Street', 'Redfern Living',
             'Stonebrook Supply', 'Thistle & Thyme', 'Underhill Goods', 'Vale & Vine', 'Westmarch Home', 'Yew Tree Trading']
EUR_CUSTOMER, BIG, WAIVED_LIMIT = 'Maison Verte SARL', 'Glenrock Home Centers', 0.35
BUCKETS = ['Current', '1-30', '31-60', '61-90', '91-120', '120+']
CATEGORIES = ['Cookware', 'Bakeware', 'Cutlery', 'Tabletop', 'Storage', 'Small appliances', 'Linens', 'Lighting']
PROCESSORS = ['Amex', 'Visa/MC', 'PayPal', 'Shop Pay']
AR_RATE, CARD_RATE, INV_RATE, CONC, SLOW_DAYS, BLOCK, FACILITY = 0.80, 0.90, 0.50, 0.25, 270, 500_000, 30_000_000
ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=2026-08-01&endPeriod=2026-08-31&format=csvdata'

with urllib.request.urlopen(ECB) as r:
    ECB_RATES = {row['TIME_PERIOD']: float(row['OBS_VALUE']) for row in csv.DictReader(r.read().decode().splitlines())}

rng = random.Random(11)
size = {c: round(10 ** rng.uniform(4.6, 6.1), -2) for c in CUSTOMERS}
size[BIG] = 5_800_000
aged = {'Underhill Goods', 'Quarry Street'}
skus = [(f'LH-{i:04d}', rng.choice(CATEGORIES), round(rng.uniform(4, 120), 2)) for i in range(1, 301)]
stale = set(rng.sample(range(300), 20))
loan = 12_500_000.0


def money(x):
    return round(x + 1e-9, 2)


def sheet(path, title, header, rows, fmt_cols=()):
    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append(header)
    for r in rows:
        ws.append(r)
    for col in fmt_cols:
        for cell in ws[col][1:]:
            cell.number_format = '#,##0.00'
    wb.save(path)


def mail(path, sender, subject, sent, body, attachment=None):
    m = EmailMessage()
    m['From'], m['To'], m['Subject'], m['Date'] = sender, 'Finance <finance@larkfield.example>', subject, sent.strftime('%a, %d %b %Y 09:00:00 -0400')
    m.set_content(body)
    if attachment:
        m.add_attachment(attachment.read_bytes(), maintype='application', subtype='vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename=attachment.name)
    path.write_bytes(bytes(m))


LENDER = 'Granite Point Credit <reports@granitepoint.example>'

for label in WEEKS:
    end = dt.date.fromisoformat(label)
    base = OUT / label
    for d in ('inputs', 'outputs', 'sources'):
        (base / d).mkdir(parents=True, exist_ok=True)
    sourced = label >= SOURCED

    rate = None
    aging = []
    for c in CUSTOMERS + ([EUR_CUSTOMER] if sourced else []):
        cur = 'EUR' if c == EUR_CUSTOMER else 'USD'
        total = (900_000 if cur == 'EUR' else size[c]) * rng.uniform(0.9, 1.1)
        split = [0.62, 0.22, 0.08, 0.04, 0.03, 0.01] if c not in aged else [0.15, 0.1, 0.05, 0.05, 0.3, 0.35]
        aging.append([c, cur] + [money(total * s * rng.uniform(0.85, 1.15)) for s in split])
    sheet(base / 'inputs' / f'Larkfield AR aging {end:%m%d%y}.xlsx', 'Aging', ['Customer', 'Currency'] + BUCKETS + ['Total'],
          [r + [money(sum(r[2:]))] for r in aging], 'CDEFGHI')
    if sourced:
        rate = ECB_RATES[max(d for d in ECB_RATES if d <= label)]

    inv = []
    for i, (sku, cat, cost) in enumerate(skus):
        loc = 'In-transit' if i % 11 == 0 else ('Store' if i % 5 == 0 else 'DC')
        last = end - dt.timedelta(days=rng.randint(290, 500) if i in stale else rng.randint(1, 60))
        qty = rng.randint(20, 1800)
        inv.append([sku, f'{cat} item {sku[-3:]}', cat, loc, qty, cost, money(qty * cost), last])
    as_of = end - dt.timedelta(days=4 if label == STALE else 1)
    header = ['SKU', 'Description', 'Category', 'Location', 'Qty', 'Unit cost', 'Ext cost', 'Last sale']
    with open(base / 'sources' / 'inventory.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['as_of'] + header)
        w.writerows([as_of.isoformat()] + r[:7] + [r[7].isoformat()] for r in inv)
    if not sourced:
        inv_name = f'Inventory at cost {as_of:%m.%d.%Y}' + (' v2' if label == TRAP else '') + '.xlsx'
        sheet(base / 'inputs' / inv_name, 'Detail', header, inv, 'FG')
    if label == TRAP:
        (base / 'bad').mkdir(exist_ok=True)
        sheet(base / 'bad' / f'Inventory at cost {as_of:%m.%d.%Y}.xlsx', 'Detail', header, inv + [r for r in inv if r[2] == 'Cookware'], 'FG')

    cards = []
    for d in range(3, 0, -1):
        day = end - dt.timedelta(days=d)
        for p in PROCESSORS:
            gross = money(rng.uniform(30_000, 210_000) * (1.6 if p == 'Visa/MC' else 1))
            fees = money(gross * 0.026)
            cards.append([f'{day:%m/%d/%Y}', p, f'{p[:2].upper()}{day:%m%d}{rng.randint(100, 999)}', gross, fees, money(gross - fees)])
    with open(base / 'inputs' / f'Card receipts {end - dt.timedelta(days=3):%m.%d}-{end - dt.timedelta(days=1):%m.%d}.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['Date', 'Processor', 'Batch', 'Gross', 'Fees', 'Net'])
        w.writerows(cards)

    opening = loan
    adv, rep = money(rng.uniform(0.7e6, 2.0e6)), money(rng.uniform(0.7e6, 2.0e6))
    interest = money(opening * 0.08 / 52)
    loan = money(opening + adv - rep + interest)
    loan_file = base / ('sources' if sourced else 'inputs') / f'Granite Point loan activity {end:%m.%d.%Y}.xlsx'
    sheet(loan_file, 'Activity', ['Item', 'Amount'],
          [['Opening balance', opening], ['Advances', adv], ['Repayments', -rep], ['Interest', interest], ['Closing balance', loan]], 'B')
    if sourced:
        monday = end + dt.timedelta(days=1)
        mail(base / 'sources' / f'{monday} Granite Point loan activity.eml', LENDER, f'Loan activity, week ending {end:%m/%d/%Y}', monday,
             'Hello,\n\nAttached is your loan activity for the week. Please let us know if you have any questions.\n\nGranite Point Credit\n', loan_file)
        loan_file.unlink()
    if label == SOURCED:
        mail(base / 'sources' / f'{end} Granite Point office closure.eml', LENDER, 'Office closure on Labor Day', end,
             'Our offices will be closed on Monday, September 7. Reports will go out on Tuesday that week.\n')
    if label == STALE:
        (base / 'extra').mkdir(exist_ok=True)
        mail(base / 'extra' / 'Granite Point concentration waiver.eml', LENDER, f'Concentration limit for {BIG}', end - dt.timedelta(days=2),
             f'Hello,\n\nWe agree to raise the concentration limit for {BIG} to {WAIVED_LIMIT:.0%} for the borrowing base as of '
             f'{end:%m/%d/%Y} only. The usual {CONC:.0%} limit applies again from the following week.\n\nGranite Point Credit\n')

    usd = [r[:2] + [money(v * rate) if r[1] == 'EUR' else v for v in r[2:]] for r in aging]
    gross_ar = money(sum(sum(r[2:]) for r in usd))
    past_due = money(sum(r[6] + r[7] for r in usd))
    cross = money(sum(sum(r[2:6]) for r in usd if (r[6] + r[7]) / sum(r[2:]) > 0.5))
    elig = {r[0]: sum(r[2:6]) for r in usd if (r[6] + r[7]) / sum(r[2:]) <= 0.5}
    pool = sum(elig.values())
    limit = {c: WAIVED_LIMIT if label == STALE and c == BIG else CONC for c in elig}
    conc = money(sum(max(0, v - limit[c] * pool) for c, v in elig.items()))
    elig_ar = money(gross_ar - past_due - cross - conc)
    card_net = money(sum(r[5] for r in cards))
    inv_total = money(sum(r[6] for r in inv))
    in_transit = money(sum(r[6] for r in inv if r[3] == 'In-transit'))
    slow = money(sum(r[6] for r in inv if r[3] != 'In-transit' and (end - r[7]).days > SLOW_DAYS))
    elig_inv = money(inv_total - in_transit - slow)
    ar_av, card_av, inv_av = money(elig_ar * AR_RATE), money(card_net * CARD_RATE), money(elig_inv * INV_RATE)
    gross_av = money(ar_av + card_av + inv_av)

    def report_lines(block):
        bb = money(min(gross_av - block, FACILITY))
        return [
            ('Gross accounts receivable', gross_ar), ('Less: over 90 days past due', -past_due),
            ('Less: cross-aged accounts (over 50% past 90 days)', -cross), (f'Less: concentration over {CONC:.0%}', -conc),
            ('Eligible accounts receivable', elig_ar), ('Advance rate', AR_RATE), ('Accounts receivable availability', ar_av),
            ('Card receipts in transit', card_net), ('Advance rate', CARD_RATE), ('Card availability', card_av),
            ('Inventory at cost', inv_total), ('Less: in-transit', -in_transit), (f'Less: slow-moving (no sale in {SLOW_DAYS} days)', -slow),
            ('Eligible inventory', elig_inv), ('Advance rate', INV_RATE), ('Inventory availability', inv_av),
            ('Gross availability', gross_av), ('Less: availability block', -block),
            ('Borrowing base', bb), ('Less: revolver balance', -loan), ('Excess availability', money(bb - loan)),
        ]

    def report(path, lines):
        wb = Workbook()
        ws = wb.active
        ws.title = 'Base'
        ws['B1'] = 'Larkfield Housewares, Inc. - Borrowing base'
        ws['B2'] = f'Week ending {end:%m/%d/%Y}'
        ws['B3'] = 'Lender: Granite Point Credit'
        for i, (k, v) in enumerate(lines, start=5):
            ws.cell(i, 2, k)
            ws.cell(i, 3, v).number_format = '0.00%' if abs(v) < 1 else '#,##0.00;(#,##0.00)'
        ws.column_dimensions['B'].width = 50
        ws.column_dimensions['C'].width = 18
        wb.save(path)

    lines = report_lines(750_000 if label > TRAP else BLOCK)
    out = f'Borrowing base Larkfield {end:%m.%d.%Y}.xlsx'
    report(base / 'outputs' / out, lines)
    truth = {'file': out, 'lines': lines, 'eur_rate': rate, 'snapshot': as_of.isoformat()}
    if label == TRAP:
        (base / 'revision').mkdir(exist_ok=True)
        report(base / 'revision' / f'Borrowing base Larkfield {end:%m.%d.%Y} reviewed.xlsx', report_lines(750_000))
        truth['revised_lines'] = report_lines(750_000)
    (base / 'truth.json').write_text(json.dumps(truth, indent=1))
    print(label, 'excess availability', lines[-1][1], f'EUR rate {rate}' if rate else '')
