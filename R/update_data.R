# Fetch all sources and write the JSON files the dashboard reads (docs/data/).
# Run from the project root:  Rscript R/update_data.R
#
# Each source is fetched independently. If one fails, its previous file is kept and the
# failure is recorded in meta.json, so the dashboard shows the last good data (flagged as
# stale) instead of breaking. Sources with `max_age_days` are only refetched once their
# file is older than that (UN Comtrade: annual data and a strict rate limit).

for (f in c("utils", "fetch_imf", "fetch_bis", "fetch_oecd", "fetch_eurostat", "fetch_ecb", "fetch_comtrade", "fetch_efv")) {
  source(file.path("R", paste0(f, ".R")))
}

out_dir <- file.path("docs", "data")
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)

read_config <- function(name) {
  read_csv(file.path("config", name), col_types = cols(.default = col_character()), na = "")
}
countries <- read_config("countries.csv")
indicators <- read_config("indicators.csv")
groups <- read_config("groups.csv")
trade_reporters <- read_config("trade_reporters.csv")
hs_chapters <- read_config("hs_chapters.csv")

# The dashboard colours up to eight countries at a time, so presets cannot be larger.
group_members <- map(set_names(groups$group), function(g) {
  countries$id[map_lgl(strsplit(coalesce(countries$groups, ""), ";"), ~ g %in% .x)]
})
too_big <- names(keep(group_members, ~ length(.x) > 8))
if (length(too_big) > 0) stop("Groups with more than 8 countries: ", paste(too_big, collapse = ", "))

sources <- list(
  list(
    id = "imf", file = "imf.json", fetch = function() fetch_imf(indicators, countries),
    name = "IMF World Economic Outlook and Fiscal Monitor",
    url = "https://www.imf.org/external/datamapper"
  ),
  list(
    id = "oecd_qna", file = "oecd_gdp.json", fetch = function() fetch_oecd_gdp(countries),
    name = "OECD Quarterly National Accounts",
    url = "https://data-explorer.oecd.org"
  ),
  list(
    id = "bis_monthly", file = "bis_monthly.json", fetch = function() fetch_bis_monthly(countries),
    name = "BIS consumer prices, policy rates and effective exchange rates",
    url = "https://data.bis.org"
  ),
  list(
    id = "bis_credit", file = "bis_credit.json", fetch = function() fetch_bis_credit(countries),
    name = "BIS total credit statistics",
    url = "https://data.bis.org/topics/TOTAL_CREDIT"
  ),
  list(
    id = "eurostat", file = "eurostat_gov.json", fetch = function() fetch_eurostat_gov(countries),
    name = "Eurostat quarterly government finance statistics",
    url = "https://ec.europa.eu/eurostat/web/government-finance-statistics"
  ),
  list(
    id = "ecb_fx", file = "ecb_fx.json", fetch = function() fetch_ecb_fx(countries),
    name = "ECB euro foreign exchange reference rates",
    url = "https://data.ecb.europa.eu/data/datasets/EXR"
  ),
  list(
    id = "eurostat_housing", file = "eurostat_housing.json", fetch = function() fetch_eurostat_housing(countries),
    name = "Eurostat EU-SILC housing tenure",
    url = "https://ec.europa.eu/eurostat/databrowser/view/ilc_lvho02/default/table"
  ),
  list(
    id = "efv_debt", file = "swiss_debt.json", fetch = function() fetch_efv_debt(),
    name = "Federal Finance Administration, government finance statistics (GFS)",
    url = "https://www.data.finance.admin.ch"
  ),
  list(
    id = "comtrade", file = "trade.json", max_age_days = 7,
    fetch = function() fetch_comtrade(trade_reporters, countries, hs_chapters),
    name = "UN Comtrade goods trade by partner and product",
    url = "https://comtradeplus.un.org"
  )
)

# Indicator ids -> the file that holds them (several sources share a file).
source_file <- c(
  imf = "imf.json", oecd_qna = "oecd_gdp.json", bis_cpi = "bis_monthly.json",
  bis_cbpol = "bis_monthly.json", bis_eer = "bis_monthly.json",
  bis_credit = "bis_credit.json", eurostat = "eurostat_gov.json",
  eurostat_silc = "eurostat_housing.json"
)

meta_file <- file.path(out_dir, "meta.json")
old_status <- if (file.exists(meta_file)) {
  read_json(meta_file)$sources |> set_names(map_chr(read_json(meta_file)$sources, "id"))
} else {
  list()
}

now <- format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC")

status <- map(sources, function(s) {
  prev <- old_status[[s$id]]
  if (!is.null(s$max_age_days) && isTRUE(prev$ok) && file.exists(file.path(out_dir, s$file))) {
    age <- difftime(Sys.time(), as.POSIXct(prev$last_success, format = "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"), units = "days")
    if (!is.na(age) && age < s$max_age_days) {
      message("Skipping ", s$id, " (refreshed ", round(age, 1), " days ago)")
      return(prev)
    }
  }
  message("Fetching ", s$id, " ...")
  started <- Sys.time()
  result <- tryCatch(s$fetch(), error = function(e) e)
  elapsed <- round(as.numeric(difftime(Sys.time(), started, units = "secs")), 1)

  if (inherits(result, "error")) {
    message("  FAILED after ", elapsed, "s: ", conditionMessage(result))
    list(
      id = s$id, name = s$name, url = s$url, file = s$file, ok = FALSE,
      error = conditionMessage(result),
      last_attempt = now,
      last_success = prev$last_success %||% NA
    )
  } else {
    write_dashboard_json(result, file.path(out_dir, s$file))
    size_kb <- round(file.size(file.path(out_dir, s$file)) / 1024)
    message("  ok in ", elapsed, "s (", size_kb, " KB)")
    list(
      id = s$id, name = s$name, url = s$url, file = s$file, ok = TRUE,
      last_attempt = now, last_success = now,
      latest_period = result$latest_period %||% tail(result$periods, 1)
    )
  }
})

meta <- list(
  generated = now,
  countries = countries |>
    transmute(id, name, currency, groups = strsplit(coalesce(groups, ""), ";")) |>
    pmap(function(id, name, currency, groups) list(id = id, name = name, currency = currency, groups = I(groups))),
  groups = map2(groups$group, groups$label, ~ list(id = .x, label = .y, members = I(group_members[[.x]]))),
  indicators = indicators |>
    mutate(file = unname(source_file[source]), decimals = as.integer(decimals)) |>
    select(id, source, code, file, label, short, unit, freq, decimals) |>
    pmap(list),
  sources = status
)
write_json(meta, meta_file, auto_unbox = TRUE, na = "null", pretty = TRUE)

failed <- keep(status, ~ !.x$ok)
if (length(failed) > 0) {
  message("\n", length(failed), " source(s) failed: ", paste(map_chr(failed, "id"), collapse = ", "))
  # Only fail the run when nothing could be updated; partial failures keep old files.
  if (length(failed) == length(sources)) quit(status = 1)
}
message("\nDone.")
