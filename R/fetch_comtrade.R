# UN Comtrade: annual goods trade by partner and by HS chapter, incl. non-monetary gold
# (HS 7108) separately so the dashboard can show trade with and without gold.
# https://comtradeplus.un.org  -  API: https://comtradedeveloper.un.org
#
# Without a key, the public preview endpoint is used: one period and at most 500 rows per
# request, and only a few requests per minute, so calls are spaced out (a full refresh
# takes a few minutes). With a free subscription key in the COMTRADE_KEY environment
# variable, the regular endpoint is used instead.

EU27_ISO3 <- c(
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN",
  "IRL", "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE"
)

comtrade_get <- function(reporter, period, flow, cmd, partner = NULL) {
  key <- Sys.getenv("COMTRADE_KEY")
  url <- if (nzchar(key)) {
    "https://comtradeapi.un.org/data/v1/get/C/A/HS"
  } else {
    "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
  }
  Sys.sleep(if (nzchar(key)) 1 else 6)

  req <- request(url) |>
    req_url_query(
      reporterCode = reporter, period = period, flowCode = flow, cmdCode = cmd,
      partnerCode = partner, partner2Code = 0, customsCode = "C00", motCode = 0,
      includeDesc = "true"
    ) |>
    req_user_agent(USER_AGENT) |>
    req_timeout(180) |>
    req_retry(
      max_tries = 5,
      is_transient = function(resp) resp_status(resp) %in% c(429, 500, 502, 503, 504),
      backoff = function(i) 20 * i
    )
  if (nzchar(key)) req <- req_headers(req, `Ocp-Apim-Subscription-Key` = key)

  js <- resp_body_json(req_perform(req), simplifyVector = TRUE)
  if (!is.null(js$error) && nzchar(js$error)) stop("Comtrade: ", js$error)
  if (length(js$data) == 0) return(tibble())
  d <- as_tibble(js$data)
  if (nrow(d) >= 500) warning("Comtrade returned 500 rows; results may be truncated.")
  d |>
    transmute(
      year = as.integer(refYear), flow = flowCode, cmd = as.character(cmdCode),
      iso = partnerISO, partner = partnerDesc, value = as.numeric(primaryValue)
    )
}

# Latest year with annual data for the reporter (tries last year, then the one before).
comtrade_latest_year <- function(reporter) {
  this_year <- as.integer(format(Sys.Date(), "%Y"))
  for (y in (this_year - 1):(this_year - 3)) {
    d <- comtrade_get(reporter, y, "X", "TOTAL", partner = 0)
    if (nrow(d) > 0) return(y)
  }
  stop("Comtrade: no recent annual data for reporter ", reporter)
}

# One value vector per year; values in USD million.
by_year <- function(d, years) {
  v <- rep(NA_real_, length(years))
  v[match(d$year, years)] <- round(d$value / 1e6, 1)
  v
}

fetch_comtrade <- function(reporters, countries, hs_chapters, n_years = 10) {
  out <- map(set_names(reporters$id), function(id) {
    code <- reporters$comtrade[reporters$id == id]
    latest <- comtrade_latest_year(code)
    years <- seq(latest - n_years + 1, latest)

    # By partner: total trade and gold, one request per flow and year (fits in 500 rows).
    partners <- map_dfr(years, function(y) {
      bind_rows(
        comtrade_get(code, y, "X", "TOTAL,7108"),
        comtrade_get(code, y, "M", "TOTAL,7108")
      )
    })
    # By HS chapter, trade with the world, both flows in one request.
    products <- map_dfr(years, ~ comtrade_get(code, .x, "X,M", "AG2", partner = 0))

    names_lookup <- setNames(countries$name, countries$id)

    flows <- map(c(X = "X", M = "M"), function(fl) {
      p <- partners |> filter(flow == fl)
      world <- p |> filter(iso == "W00")
      total <- by_year(world |> filter(cmd == "TOTAL"), years)
      gold <- by_year(world |> filter(cmd == "7108"), years)
      gold[is.na(gold) & !is.na(total)] <- 0

      ctry <- p |> filter(iso != "W00")
      partner_list <- ctry |>
        split(ctry$iso) |>
        imap(function(d, iso) {
          incl <- by_year(d |> filter(cmd == "TOTAL"), years)
          g <- by_year(d |> filter(cmd == "7108"), years)
          entry <- list(name = unname(coalesce(names_lookup[iso], d$partner[1])), incl = incl)
          if (any(!is.na(g))) entry$gold <- replace(g, is.na(g) & !is.na(incl), 0)
          entry
        })

      eu <- ctry |>
        filter(iso %in% EU27_ISO3) |>
        group_by(year, cmd) |>
        summarise(value = sum(value, na.rm = TRUE), .groups = "drop")
      partner_list$EU27 <- list(
        name = "EU-27",
        incl = by_year(eu |> filter(cmd == "TOTAL"), years),
        gold = by_year(eu |> filter(cmd == "7108"), years)
      )

      pr <- products |> filter(flow == fl)
      chapter_names <- setNames(hs_chapters$label, hs_chapters$code)
      product_list <- pr |>
        split(pr$cmd) |>
        imap(function(d, ch) {
          entry <- list(name = unname(coalesce(chapter_names[ch], paste("HS", ch))), incl = by_year(d, years))
          # Gold (HS 7108) sits in chapter 71.
          if (ch == "71") entry$gold <- gold
          entry
        })

      list(total = total, gold = gold, partners = partner_list, products = product_list)
    })

    list(name = unname(names_lookup[id]), years = years, flows = flows)
  })

  list(unit = "USD million", periods = as.character(unique(unlist(map(out, "years")))), reporters = out)
}
