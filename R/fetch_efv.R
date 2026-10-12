# Swiss public debt from the Federal Finance Administration's GFS data (data.finance.admin.ch):
# - balance sheets (sheet "vermoegen") of general government and its subsectors, from which
#   gross and net debt (IMF definitions) and their main components are computed;
# - Maastricht debt and nominal GDP (incl. FFA forecasts) from main_extern.xlsx.

EFV_URL <- "https://www.data.finance.admin.ch/static/assets/datasets/gfs_dashboard/"

EFV_SECTORS <- tibble::tribble(
  ~id,     ~file,     ~maastricht,            ~name,
  "staat", "staat-e", "Staat",                "General government",
  "bund",  "bund-e",  "Bund",                 "Confederation",
  "ktn",   "ktn-e",   "Kantone",              "Cantons",
  "gdn",   "gdn-e",   "Gemeinden",            "Municipalities",
  "sv",    "sv-e",    "Sozialversicherungen", "Social security funds"
)

# Debt instruments: GFS liability codes 630x and the matching financial asset codes 620x.
# Equity (x5) and financial derivatives (x7) are excluded by both IMF debt definitions.
EFV_INSTRUMENTS <- c(
  "1" = "Monetary gold and SDRs", "2" = "Currency and deposits", "3" = "Debt securities",
  "4" = "Loans", "6" = "Insurance, pension and guarantee schemes", "8" = "Other accounts payable"
)
EFV_ASSET_LABELS <- c("8" = "Other accounts receivable")

efv_download <- function(file) {
  path <- tempfile(fileext = ".xlsx")
  request(paste0(EFV_URL, file, ".xlsx")) |>
    req_user_agent(USER_AGENT) |>
    req_timeout(120) |>
    req_retry(max_tries = 3, backoff = function(i) 10 * i) |>
    req_perform(path = path)
  path
}

# Balance sheet as a code x year matrix in CHF million.
efv_balance_sheet <- function(path) {
  v <- readxl::read_excel(path, sheet = "vermoegen", col_names = FALSE, .name_repair = "minimal")
  header <- which(grepl("^CHF", v[[2]]))[1]
  if (is.na(header)) stop("vermoegen: header row ('CHF 1 000') not found")
  scale <- if (grepl("1 000", v[[2]][header])) 1e-3 else 1
  years <- as.character(as.integer(unlist(v[header, -(1:2)])))
  rows <- (header + 1):nrow(v)
  m <- as.matrix(v[rows, -(1:2)])
  m <- matrix(suppressWarnings(as.numeric(m)), nrow = length(rows), dimnames = list(as.character(v[[1]][rows]), years))
  m <- m[!is.na(rownames(m)) & rownames(m) != "NA", , drop = FALSE]
  m[is.na(m)] <- 0
  m * scale
}

pos <- function(m, code) if (code %in% rownames(m)) m[code, ] else rep(0, ncol(m))

# Total plus the `n` largest components (by absolute value in the latest year), with the rest
# aggregated as "Others" (split by sign for net debt, so liabilities and assets stay apart).
debt_breakdown <- function(m, net) {
  liab <- map(names(EFV_INSTRUMENTS), function(k) {
    list(code = paste0("630", k), instrument = k, side = "L", label = unname(EFV_INSTRUMENTS[k]), values = pos(m, paste0("630", k)))
  })
  gross <- pos(m, "630") - pos(m, "6305") - pos(m, "6307")
  comps <- liab
  total <- gross
  if (net) {
    assets <- map(names(EFV_INSTRUMENTS), function(k) {
      lab <- coalesce(unname(EFV_ASSET_LABELS[k]), unname(EFV_INSTRUMENTS[k]))
      list(code = paste0("620", k), instrument = k, side = "A", label = paste0(lab, " (assets)"), values = -pos(m, paste0("620", k)))
    })
    comps <- c(liab, assets)
    total <- gross - (pos(m, "620") - pos(m, "6205") - pos(m, "6207"))
  }
  last <- ncol(m)
  size <- map_dbl(comps, ~ abs(.x$values[last]))
  top <- comps[order(size, decreasing = TRUE)][seq_len(min(4, sum(size > 0)))]
  top <- top[order(map_chr(top, "side") == "A", map_chr(top, "instrument"))]
  rest <- keep(comps, ~ !(.x$code %in% map_chr(top, "code")))

  others <- list()
  for (side in if (net) c("L", "A") else "L") {
    r <- keep(rest, ~ .x$side == side)
    if (length(r) == 0) next
    v <- Reduce(`+`, map(r, "values"))
    if (all(abs(v) < 1e-9)) next
    others[[length(others) + 1]] <- list(
      code = "other", instrument = "other", side = side,
      label = if (!net) "Others" else if (side == "L") "Other liabilities" else "Other financial assets",
      values = v
    )
  }

  list(
    total = round(total, 1),
    components = map(c(top, others), function(x) {
      x$values <- round(x$values, 1)
      x
    })
  )
}

fetch_efv_debt <- function() {
  sheets <- map(set_names(EFV_SECTORS$id), ~ efv_balance_sheet(efv_download(EFV_SECTORS$file[EFV_SECTORS$id == .x])))
  main <- efv_download("main_extern")

  # Nominal GDP (CHF million, incl. forecasts).
  gdp_raw <- readxl::read_excel(main, sheet = "gdp", col_names = FALSE, .name_repair = "minimal")
  gdp <- tibble(year = suppressWarnings(as.integer(gdp_raw[[1]])), value = suppressWarnings(as.numeric(gdp_raw[[3]]))) |>
    filter(!is.na(year), !is.na(value))

  # Maastricht debt: the block of columns headed "Maastricht-Schuld", one column per sector.
  g <- readxl::read_excel(main, sheet = "gfs", col_names = FALSE, .name_repair = "minimal")
  head_rows <- 1:min(10, nrow(g))
  table_row <- which(apply(g[head_rows, ], 1, function(r) any(grepl("Maastricht", r))))[1]
  if (is.na(table_row)) stop("gfs sheet: Maastricht block not found")
  table_names <- zoo_fill(unlist(g[table_row, ]))
  sector_names <- zoo_fill(unlist(g[table_row + 1, ]), within = table_names)
  years_g <- suppressWarnings(as.integer(g[[1]]))
  maastricht <- map(set_names(EFV_SECTORS$id), function(id) {
    col <- which(grepl("Maastricht", table_names) & sector_names == EFV_SECTORS$maastricht[EFV_SECTORS$id == id])[1]
    if (is.na(col)) stop("Maastricht column not found for ", id)
    tibble(year = years_g, value = suppressWarnings(as.numeric(g[[col]]))) |> filter(!is.na(year), !is.na(value))
  })

  bs_years <- as.integer(colnames(sheets[[1]]))
  periods <- as.character(seq(min(bs_years, gdp$year), max(bs_years, gdp$year, map_dbl(maastricht, ~ max(.x$year)))))
  align <- function(years, values) {
    out <- rep(NA_real_, length(periods))
    out[match(as.character(years), periods)] <- values
    out
  }
  pad <- function(x) {
    x$total <- align(bs_years, x$total)
    x$components <- map(x$components, function(cmp) { cmp$values <- align(bs_years, cmp$values); cmp })
    x
  }

  list(
    unit = "CHF million",
    periods = periods,
    projection_start = as.character(max(bs_years) + 1),
    latest_period = as.character(max(bs_years)),
    gdp = align(gdp$year, round(gdp$value, 1)),
    sectors = map(EFV_SECTORS$id, function(id) {
      m <- sheets[[id]]
      list(
        id = id,
        name = EFV_SECTORS$name[EFV_SECTORS$id == id],
        gross = pad(debt_breakdown(m, net = FALSE)),
        net = pad(debt_breakdown(m, net = TRUE)),
        maastricht = align(maastricht[[id]]$year, round(maastricht[[id]]$value, 1))
      )
    })
  )
}

# Fill a header row forward (merged cells come through as NA), optionally restarting at each
# change of an outer header.
zoo_fill <- function(x, within = NULL) {
  x <- as.character(x)
  out <- x
  for (i in seq_along(x)) {
    restart <- !is.null(within) && i > 1 && !identical(within[i], within[i - 1])
    if (is.na(out[i]) && i > 1 && !restart) out[i] <- out[i - 1]
  }
  out
}
