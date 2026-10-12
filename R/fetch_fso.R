# Federal Statistical Office (FSO): housing tenure from the structural survey (Strukturerhebung),
# by canton, since 2019. Tables are looked up by their order number in the FSO's asset API,
# which always returns the current release.
# https://www.bfs.admin.ch/bfs/en/home/statistics/construction-housing/dwellings/housing-conditions/tenants-owners.html

FSO_DAM <- "https://dam-api.bfs.admin.ch/hub/api/dam/assets"

fso_csv <- function(order_nr) {
  js <- get_json(paste0(FSO_DAM, "?orderNr=", order_nr, "&language=en"))
  current <- keep(js$data, ~ identical(.x$bfs$lifecycleGroup, "CURRENT"))
  if (length(current) == 0) stop("FSO: no current asset for ", order_nr)
  txt <- resp_body_string(http_get(paste0(FSO_DAM, "/", current[[1]]$ids$damId, "/master")))
  d <- read_delim(I(txt), delim = ";", col_types = cols(.default = col_character()), progress = FALSE)
  names(d) <- gsub("[^A-Z_]", "", names(d))  # drop a byte-order mark, if any
  d
}

fso_series <- function(d, periods) {
  v <- rep(NA_real_, length(periods))
  v[match(d$TIME_PERIOD, periods)] <- as_num(d$OBS_VALUE)
  v
}

fetch_fso_housing <- function(cantons) {
  rate <- fso_csv("ts-x-09.03.02.01.03b")     # homeownership rate, % of occupied dwellings
  status <- fso_csv("ts-x-09.03.02.01.03a")   # occupied dwellings by occupancy status

  periods <- sort(unique(c(rate$TIME_PERIOD, status$TIME_PERIOD)))
  # Occupancy status codes, in the order of the FSO's table description.
  status_ids <- c("1" = "tenant", "2" = "coop", "3" = "condo", "4" = "house", "5" = "other", Total = "total")

  geos <- intersect(cantons$geo, unique(rate$GEO))
  by_geo <- map(set_names(geos), function(g) {
    r <- rate |> filter(GEO == g)
    ci <- rep(NA_real_, length(periods))
    ci[match(r$TIME_PERIOD, periods)] <- as_num(r$OBS_CONFIDENCE)
    s <- status |> filter(GEO == g)
    dwellings <- map(set_names(names(status_ids), status_ids), ~ fso_series(s |> filter(INDICATOR == .x), periods))
    list(
      name = cantons$name[cantons$geo == g],
      abbr = cantons$abbr[cantons$geo == g],
      rate = fso_series(r, periods),
      rate_ci = ci,
      dwellings = dwellings
    )
  })

  list(periods = periods, latest_period = tail(periods, 1), geos = by_geo)
}
