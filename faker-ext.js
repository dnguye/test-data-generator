/* ---------------------------------------------------------------------------
   faker-ext.js — custom generator modules for Test Data Generator.

   Loaded as a classic script AFTER faker.iife.js and BEFORE the app's module
   script, so everything defined here is picked up by the catalog walk that
   builds the type list at boot (see FAKER_METHODS in index.html).

   Four rules the catalog enforces, so follow them when adding your own:
     1. Modules are flat objects on `faker` — faker.mod.method, never deeper.
     2. Methods take no arguments; the app calls them as fn().
     3. Methods must return something defined (an empty string is fine).
     4. Randomness must come from faker's own methods, never Math.random(),
        or the field stops honouring the seed while every other field keeps
        honouring it — a silent divergence that is painful to track down.

   Methods are invoked as fn.apply(null), so `this` is not available here.
   Reference the closure variables (f, pick, …) instead.
--------------------------------------------------------------------------- */
(function () {
  "use strict";
  if (typeof FakerLib === "undefined" || !FakerLib || !FakerLib.faker) return;

  var F = FakerLib;
  var f = F.faker;

  /* ---------- small helpers, all seeded through faker ---------- */
  function pick(a) { return f.helpers.arrayElement(a); }
  function weight(pairs) { return f.helpers.weightedArrayElement(pairs); }
  function num(n) { return f.string.numeric({ length: n, allowLeadingZeros: true }); }
  function alpha(n) { return f.string.alpha({ length: n, casing: "upper" }); }
  function int(min, max) { return f.number.int({ min: min, max: max }); }
  function chance(pct) { return int(1, 100) <= pct; }
  function round(v, p) { var m = Math.pow(10, p); return Math.round(v * m) / m; }

  /* Luhn check digit for a string of digits. */
  function luhn(s) {
    var sum = 0, alt = true;
    for (var i = s.length - 1; i >= 0; i--) {
      var d = +s.charAt(i);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    return (10 - (sum % 10)) % 10;
  }

  /* =========================================================================
     unwrap — flat accessors for the faker methods that return objects or
     arrays. Those render as [object Object] in CSV and XML; these do not.
     ========================================================================= */
  f.unwrap = {
    languageName:       function () { return f.location.language().name; },
    languageAlpha2:     function () { return f.location.language().alpha2; },
    languageAlpha3:     function () { return f.location.language().alpha3; },
    airportName:        function () { return f.airline.airport().name; },
    airportIata:        function () { return f.airline.airport().iataCode; },
    airlineName:        function () { return f.airline.airline().name; },
    airlineIata:        function () { return f.airline.airline().iataCode; },
    airplaneName:       function () { return f.airline.airplane().name; },
    airplaneIata:       function () { return f.airline.airplane().iataTypeCode; },
    currencyName:       function () { return f.finance.currency().name; },
    currencyCode:       function () { return f.finance.currency().code; },
    currencySymbol:     function () { return f.finance.currency().symbol || "$"; },
    currencyNumeric:    function () { return f.finance.currency().numericCode; },
    elementName:        function () { return f.science.chemicalElement().name; },
    elementSymbol:      function () { return f.science.chemicalElement().symbol; },
    elementAtomicNumber:function () { return String(f.science.chemicalElement().atomicNumber); },
    unitName:           function () { return f.science.unit().name; },
    unitSymbol:         function () { return f.science.unit().symbol; },
    colorHsl: function () {
      var c = f.color.hsl();
      return "hsl(" + Math.round(c[0]) + ", " + Math.round(c[1] * 100) + "%, " + Math.round(c[2] * 100) + "%)";
    },
    colorHwb: function () {
      var c = f.color.hwb();
      return "hwb(" + Math.round(c[0]) + " " + Math.round(c[1] * 100) + "% " + Math.round(c[2] * 100) + "%)";
    },
    colorCmyk: function () {
      var c = f.color.cmyk();
      return "cmyk(" + c.map(function (v) { return Math.round(v * 100) + "%"; }).join(", ") + ")";
    },
    colorLab: function () {
      var c = f.color.lab();
      return "lab(" + round(c[0] * 100, 2) + "% " + round(c[1], 2) + " " + round(c[2], 2) + ")";
    },
    colorLch: function () {
      var c = f.color.lch();
      return "lch(" + round(c[0] * 100, 2) + "% " + round(c[1], 2) + " " + round(c[2], 2) + ")";
    }
  };

  /* =========================================================================
     ids — identifiers shaped like the ones real CRM and ERP systems issue.
     ========================================================================= */
  var SF_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

  /* Salesforce turns a 15-char case-sensitive id into an 18-char
     case-insensitive one by appending 3 chars that encode which of the 15
     characters are uppercase. */
  function sfSuffix(id15) {
    var out = "";
    for (var c = 0; c < 3; c++) {
      var bits = 0;
      for (var i = 0; i < 5; i++) {
        var ch = id15.charAt(c * 5 + i);
        if (ch >= "A" && ch <= "Z") bits |= 1 << i;
      }
      out += SF_MAP.charAt(bits);
    }
    return out;
  }
  function sf15(prefix) {
    return prefix + f.string.alphanumeric({ length: 12, casing: "mixed" });
  }
  function sf18(prefix) { var id = sf15(prefix); return id + sfSuffix(id); }

  f.ids = {
    salesforce15:          function () { return sf15(pick(["001", "003", "006", "00Q", "500", "701"])); },
    salesforce18:          function () { return sf18(pick(["001", "003", "006", "00Q", "500", "701"])); },
    salesforceAccount:     function () { return sf18("001"); },
    salesforceContact:     function () { return sf18("003"); },
    salesforceLead:        function () { return sf18("00Q"); },
    salesforceOpportunity: function () { return sf18("006"); },
    salesforceCase:        function () { return sf18("500"); },
    sapCustomer:           function () { return num(10); },
    sapMaterial:           function () { return num(18); },
    netsuiteInternal:      function () { return String(int(1, 999999)); },
    dynamicsGuid:          function () { return "{" + f.string.uuid().toUpperCase() + "}"; },
    hubspotObjectId:       function () { return String(int(1000000000, 99999999999)); },
    zendeskTicket:         function () { return String(int(1, 999999)); },
    jiraIssueKey:          function () { return alpha(int(2, 4)) + "-" + int(1, 9999); }
  };

  /* =========================================================================
     ident — identifiers with real, verifiable check digits. Useful when the
     system under test validates rather than just stores.
     ========================================================================= */
  var EIN_PREFIX = ["01","02","03","04","05","06","10","11","12","13","14","15","16",
                    "20","21","22","23","24","25","26","27","30","31","32","33","34",
                    "35","36","37","38","39","41","42","43","44","45","46","47","48",
                    "50","51","52","53","54","55","56","57","58","59","60","61","62",
                    "63","64","65","66","67","68","71","72","73","74","75","76","77",
                    "80","81","82","83","84","85","86","87","88","90","91","92","93",
                    "94","95","98","99"];
  var VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789"; /* no I, O or Q */
  var VIN_VALUE = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,
                    P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
  var VIN_WEIGHT = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];

  function gtinCheck(body, firstWeight) {
    var sum = 0;
    for (var i = 0; i < body.length; i++) {
      sum += (+body.charAt(i)) * ((i % 2 === 0) ? firstWeight : (firstWeight === 3 ? 1 : 3));
    }
    return (10 - (sum % 10)) % 10;
  }

  f.ident = {
    /* Area 001-899 excluding 666, group 01-99, serial 0001-9999. */
    ssn: function () {
      var area = int(1, 899);
      if (area === 666) area = 667;
      return String(area).padStart(3, "0") + "-" + String(int(1, 99)).padStart(2, "0") +
             "-" + String(int(1, 9999)).padStart(4, "0");
    },
    ein: function () { return pick(EIN_PREFIX) + "-" + num(7); },
    /* NPI: Luhn over the 80840 prefix plus the 9-digit body. */
    npi: function () {
      var body = String(pick([1, 2])) + num(8);
      return body + luhn("80840" + body);
    },
    /* ABA: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) must be 0 mod 10. */
    abaRouting: function () {
      var d = [];
      for (var i = 0; i < 8; i++) d.push(int(0, 9));
      var s = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5]);
      d.push((10 - (s % 10)) % 10);
      return d.join("");
    },
    isin: function () {
      var body = pick(["US", "GB", "DE", "FR", "JP", "CA", "CH", "NL", "AU"]) +
                 f.string.alphanumeric({ length: 9, casing: "upper" });
      var expanded = "";
      for (var i = 0; i < body.length; i++) {
        var ch = body.charAt(i);
        expanded += (ch >= "0" && ch <= "9") ? ch : String(ch.charCodeAt(0) - 55);
      }
      return body + luhn(expanded);
    },
    gtin13: function () { var b = num(12); return b + gtinCheck(b, 1); },
    upc12:  function () { var b = num(11); return b + gtinCheck(b, 3); },
    /* VIN with a correct position-9 check digit. */
    vin: function () {
      var chars = [], i;
      for (i = 0; i < 17; i++) chars.push(VIN_ALPHABET.charAt(int(0, VIN_ALPHABET.length - 1)));
      chars[8] = "0";
      var sum = 0;
      for (i = 0; i < 17; i++) {
        var c = chars[i];
        var v = (c >= "0" && c <= "9") ? +c : VIN_VALUE[c];
        sum += v * VIN_WEIGHT[i];
      }
      var r = sum % 11;
      chars[8] = (r === 10) ? "X" : String(r);
      return chars.join("");
    },
    /* NHS number: 10 digits, weights 10..2, mod 11. */
    nhsNumber: function () {
      for (var attempt = 0; attempt < 20; attempt++) {
        var body = num(9), sum = 0;
        for (var i = 0; i < 9; i++) sum += (+body.charAt(i)) * (10 - i);
        var check = 11 - (sum % 11);
        if (check === 11) check = 0;
        if (check === 10) continue;
        return body.slice(0, 3) + " " + body.slice(3, 6) + " " + body.slice(6) + check;
      }
      return "400 000 0004";
    },
    /* Canadian SIN: 9 digits, Luhn-valid. */
    sinCanada: function () {
      var body = String(int(1, 9)) + num(7);
      var full = body + luhn(body);
      return full.slice(0, 3) + " " + full.slice(3, 6) + " " + full.slice(6);
    }
  };

  /* =========================================================================
     dirty — the values real source systems actually contain. Built for
     testing ingestion, normalisation and matching, not for looking pretty.
     ========================================================================= */
  var NULLISH = ["NULL", "null", "N/A", "n/a", "#N/A", "-", "", "None", "(blank)",
                 "TBD", "UNKNOWN", "?", "."];
  var TYPO_DOMAIN = ["gmial.com", "gmai.com", "gmail.co", "yahoo.con", "yaho.com",
                     "hotmial.com", "hotmail.co", "outlook.con", "iclould.com"];

  function localeFaker(loc) {
    return new F.Faker({ locale: [loc, F.en, F.base], randomizer: f._randomizer });
  }
  var accented = [localeFaker(F.fr), localeFaker(F.de), localeFaker(F.es), localeFaker(F.pl)];
  var cjk = [localeFaker(F.ja), localeFaker(F.zh_CN), localeFaker(F.ko)];

  f.dirty = {
    blank:      function () { return ""; },
    nullish:    function () { return pick(NULLISH); },
    whitespacePadded: function () {
      return pick(["  ", " ", "\t", "   "]) + f.person.fullName() + pick(["  ", " ", "\t", ""]);
    },
    doubleSpaced: function () { return f.person.firstName() + "  " + f.person.lastName(); },
    mixedCase: function () {
      var s = f.company.name(), out = "";
      for (var i = 0; i < s.length; i++) out += chance(50) ? s.charAt(i).toUpperCase() : s.charAt(i).toLowerCase();
      return out;
    },
    allCaps:  function () { return f.person.fullName().toUpperCase(); },
    allLower: function () { return f.person.fullName().toLowerCase(); },
    /* Reads as a number, but the leading zeros are lost the moment anything
       parses it as one. */
    leadingZeroNumber: function () { return "000".slice(0, int(1, 3)) + num(int(4, 6)); },
    /* 1,234.56 vs 1.234,56 — the same amount, two incompatible conventions. */
    numberAsText: function () {
      var whole = int(1000, 9999999), cents = String(int(0, 99)).padStart(2, "0");
      var grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return chance(50) ? grouped + "." + cents
                        : grouped.replace(/,/g, ".") + "," + cents;
    },
    smartQuoteName: function () { return pick(["O", "D", "L"]) + "’" + f.person.lastName(); },
    accentedName:   function () { return pick(accented).person.fullName(); },
    cjkName:        function () { return pick(cjk).person.fullName(); },
    htmlEntity:     function () { return f.person.lastName() + " &amp; " + pick(["Sons", "Co", "Partners"]) + " &lt;Inc&gt;"; },
    emailTypo:      function () { return f.internet.username().toLowerCase() + "@" + pick(TYPO_DOMAIN); },
    emailWithPlus:  function () { return f.internet.username().toLowerCase() + "+" + f.word.noun() + "@" + f.internet.domainName(); },
    phoneMessy: function () {
      var a = int(200, 989), b = int(200, 999), c = String(int(0, 9999)).padStart(4, "0");
      return pick([
        "(" + a + ") " + b + "-" + c, a + "." + b + "." + c, a + "-" + b + "-" + c,
        "+1 " + a + " " + b + " " + c, "" + a + b + c, a + "-" + b + "-" + c + " ext " + int(1, 999),
        "1-" + a + "-" + b + "-" + c
      ]);
    },
    dateMessy: function () {
      var d = f.date.past({ years: 5 });
      var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
      var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      var p2 = function (n) { return String(n).padStart(2, "0"); };
      return pick([
        p2(m) + "/" + p2(day) + "/" + y, p2(day) + "/" + p2(m) + "/" + y,
        y + "-" + p2(m) + "-" + p2(day), MON[m - 1] + " " + day + ", " + y,
        day + "-" + MON[m - 1] + "-" + String(y).slice(2), "" + y + p2(m) + p2(day)
      ]);
    },
    addressMessy: function () {
      var n = int(1, 9999), street = f.location.street();
      var v = pick([
        n + " " + street, n + " " + street.replace(/Street/, "St.").replace(/Avenue/, "Ave"),
        (n + " " + street).toUpperCase(), n + " " + street + ", Apt " + int(1, 99),
        n + " " + street + " #" + int(1, 99), "  " + n + " " + street + " "
      ]);
      return v;
    },
    truncated: function () { return f.company.name().slice(0, int(8, 20)); },
    /* Contains a comma, a quote and a newline — exercises the consumer's CSV
       parser. This app quotes it correctly on export, which is the point. */
    csvBreaker: function () {
      return f.person.lastName() + ', "' + f.person.firstName() + '"\n' + pick(["Jr.", "Sr.", "III"]);
    },
    /* Cyrillic а/е/о and Greek ο look identical to Latin but never match. */
    unicodeConfusable: function () {
      var s = f.company.name(), map = { a: "а", e: "е", o: "о", c: "с", p: "р" };
      var hit = false, out = "";
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i), low = ch.toLowerCase();
        if (map[low] && !hit && chance(60)) { out += map[low]; hit = true; }
        else out += ch;
      }
      return out;
    },
    /* Invisible characters that survive a copy-paste and break equality. */
    zeroWidth: function () {
      var s = f.person.fullName(), i = int(1, s.length - 1);
      return s.slice(0, i) + pick(["​", "‌", "﻿"]) + s.slice(i);
    }
  };

  /* =========================================================================
     weighted — realistic skew instead of uniform picks. Uniform data hides
     the long-tail bugs; a 70/20/10 split does not.
     ========================================================================= */
  f.weighted = {
    customerTier: function () {
      return weight([{ weight: 70, value: "Standard" }, { weight: 20, value: "Premium" },
                     { weight: 10, value: "Enterprise" }]);
    },
    accountStatus: function () {
      return weight([{ weight: 80, value: "Active" }, { weight: 12, value: "Inactive" },
                     { weight: 5, value: "Suspended" }, { weight: 3, value: "Closed" }]);
    },
    leadSource: function () {
      return weight([{ weight: 40, value: "Web" }, { weight: 20, value: "Referral" },
                     { weight: 15, value: "Event" }, { weight: 10, value: "Partner" },
                     { weight: 8, value: "Cold Call" }, { weight: 7, value: "Other" }]);
    },
    priority: function () {
      return weight([{ weight: 45, value: "Low" }, { weight: 35, value: "Medium" },
                     { weight: 15, value: "High" }, { weight: 5, value: "Critical" }]);
    },
    channel: function () {
      return weight([{ weight: 45, value: "Email" }, { weight: 25, value: "Phone" },
                     { weight: 18, value: "Web" }, { weight: 12, value: "Chat" }]);
    },
    industry: function () {
      return weight([{ weight: 18, value: "Technology" }, { weight: 15, value: "Retail" },
                     { weight: 12, value: "Healthcare" }, { weight: 11, value: "Financial Services" },
                     { weight: 10, value: "Manufacturing" }, { weight: 8, value: "Education" },
                     { weight: 8, value: "Construction" }, { weight: 7, value: "Transportation" },
                     { weight: 6, value: "Energy" }, { weight: 5, value: "Government" }]);
    },
    country: function () {
      return weight([{ weight: 55, value: "United States" }, { weight: 8, value: "United Kingdom" },
                     { weight: 7, value: "Canada" }, { weight: 6, value: "Germany" },
                     { weight: 5, value: "France" }, { weight: 4, value: "Australia" },
                     { weight: 4, value: "India" }, { weight: 3, value: "Japan" },
                     { weight: 3, value: "Brazil" }, { weight: 3, value: "Mexico" },
                     { weight: 2, value: "Netherlands" }]);
    },
    usState: function () {
      return weight([{ weight: 12, value: "CA" }, { weight: 9, value: "TX" }, { weight: 7, value: "FL" },
                     { weight: 6, value: "NY" }, { weight: 4, value: "PA" }, { weight: 4, value: "IL" },
                     { weight: 3, value: "OH" }, { weight: 3, value: "GA" }, { weight: 3, value: "NC" },
                     { weight: 3, value: "MI" }, { weight: 2, value: "NJ" }, { weight: 2, value: "VA" },
                     { weight: 2, value: "WA" }, { weight: 2, value: "AZ" }, { weight: 2, value: "MA" },
                     { weight: 36, value: "OTHER" }]);
    },
    emailDomain: function () {
      return weight([{ weight: 38, value: "gmail.com" }, { weight: 12, value: "yahoo.com" },
                     { weight: 10, value: "hotmail.com" }, { weight: 8, value: "outlook.com" },
                     { weight: 6, value: "icloud.com" }, { weight: 4, value: "aol.com" },
                     { weight: 22, value: f.internet.domainName() }]);
    },
    yesNo:    function () { return weight([{ weight: 80, value: "Yes" }, { weight: 20, value: "No" }]); },
    mostlyTrue: function () { return weight([{ weight: 90, value: "true" }, { weight: 10, value: "false" }]); }
  };

  /* =========================================================================
     geo* — country pools scoped to one region, with postal codes that match
     the country's real format.

     country(), countryCode() and city() are independent draws: use them when
     only one field matters. When country, city and postal code must AGREE on
     a row, use place() — it returns one JSON object — and split it with
     formulas:  JSON.parse(field('_src')).city
     ========================================================================= */
  function ukPostcode() {
    return alpha(int(1, 2)) + int(1, 99) + " " + int(0, 9) + alpha(2);
  }
  var REGIONS = {
    NorthAmerica: [
      { c: "United States", k: "US", cities: ["Dallas", "Atlanta", "Phoenix", "Boston", "Denver", "Seattle"], z: function () { return num(5); } },
      { c: "Canada", k: "CA", cities: ["Toronto", "Vancouver", "Calgary", "Montreal", "Ottawa"], z: function () { return alpha(1) + int(0, 9) + alpha(1) + " " + int(0, 9) + alpha(1) + int(0, 9); } },
      { c: "Mexico", k: "MX", cities: ["Guadalajara", "Monterrey", "Puebla", "Mérida", "Tijuana"], z: function () { return num(5); } }
    ],
    LatinAmerica: [
      { c: "Brazil", k: "BR", cities: ["São Paulo", "Rio de Janeiro", "Belo Horizonte", "Curitiba"], z: function () { return num(5) + "-" + num(3); } },
      { c: "Argentina", k: "AR", cities: ["Buenos Aires", "Córdoba", "Rosario", "Mendoza"], z: function () { return alpha(1) + num(4) + alpha(3); } },
      { c: "Chile", k: "CL", cities: ["Santiago", "Valparaíso", "Concepción"], z: function () { return num(7); } },
      { c: "Colombia", k: "CO", cities: ["Bogotá", "Medellín", "Cali", "Barranquilla"], z: function () { return num(6); } },
      { c: "Peru", k: "PE", cities: ["Lima", "Arequipa", "Trujillo"], z: function () { return num(5); } }
    ],
    Europe: [
      { c: "United Kingdom", k: "GB", cities: ["Manchester", "Bristol", "Leeds", "Glasgow", "Sheffield"], z: ukPostcode },
      { c: "Germany", k: "DE", cities: ["Munich", "Hamburg", "Cologne", "Stuttgart", "Leipzig"], z: function () { return num(5); } },
      { c: "France", k: "FR", cities: ["Lyon", "Marseille", "Toulouse", "Nantes", "Bordeaux"], z: function () { return num(5); } },
      { c: "Spain", k: "ES", cities: ["Valencia", "Seville", "Zaragoza", "Málaga", "Bilbao"], z: function () { return num(5); } },
      { c: "Italy", k: "IT", cities: ["Milan", "Turin", "Bologna", "Florence", "Naples"], z: function () { return num(5); } },
      { c: "Netherlands", k: "NL", cities: ["Rotterdam", "Utrecht", "Eindhoven", "Groningen"], z: function () { return num(4) + " " + alpha(2); } },
      { c: "Poland", k: "PL", cities: ["Kraków", "Wrocław", "Poznań", "Gdańsk"], z: function () { return num(2) + "-" + num(3); } },
      { c: "Sweden", k: "SE", cities: ["Gothenburg", "Malmö", "Uppsala", "Västerås"], z: function () { return num(3) + " " + num(2); } }
    ],
    AsiaPacific: [
      { c: "Japan", k: "JP", cities: ["Osaka", "Nagoya", "Fukuoka", "Sapporo", "Kobe"], z: function () { return num(3) + "-" + num(4); } },
      { c: "China", k: "CN", cities: ["Shanghai", "Shenzhen", "Chengdu", "Hangzhou", "Xi'an"], z: function () { return num(6); } },
      { c: "India", k: "IN", cities: ["Pune", "Chennai", "Jaipur", "Hyderabad", "Ahmedabad"], z: function () { return num(6); } },
      { c: "Singapore", k: "SG", cities: ["Singapore"], z: function () { return num(6); } },
      { c: "Australia", k: "AU", cities: ["Melbourne", "Brisbane", "Perth", "Adelaide"], z: function () { return num(4); } },
      { c: "South Korea", k: "KR", cities: ["Busan", "Incheon", "Daegu", "Daejeon"], z: function () { return num(5); } }
    ],
    MiddleEastAfrica: [
      /* The UAE has no postal code system at all — an empty value here is
         correct, and a good test of what the consumer does with one. */
      { c: "United Arab Emirates", k: "AE", cities: ["Dubai", "Abu Dhabi", "Sharjah"], z: function () { return ""; } },
      { c: "Saudi Arabia", k: "SA", cities: ["Riyadh", "Jeddah", "Dammam"], z: function () { return num(5) + "-" + num(4); } },
      { c: "Israel", k: "IL", cities: ["Tel Aviv", "Haifa", "Jerusalem"], z: function () { return num(7); } },
      { c: "South Africa", k: "ZA", cities: ["Cape Town", "Durban", "Pretoria", "Johannesburg"], z: function () { return num(4); } },
      { c: "Nigeria", k: "NG", cities: ["Lagos", "Abuja", "Ibadan", "Kano"], z: function () { return num(6); } },
      { c: "Egypt", k: "EG", cities: ["Cairo", "Alexandria", "Giza"], z: function () { return num(5); } },
      { c: "Kenya", k: "KE", cities: ["Nairobi", "Mombasa", "Kisumu"], z: function () { return num(5); } }
    ]
  };

  Object.keys(REGIONS).forEach(function (key) {
    var list = REGIONS[key];
    f["geo" + key] = {
      country:     function () { return pick(list).c; },
      countryCode: function () { return pick(list).k; },
      city:        function () { return pick(pick(list).cities); },
      postal:      function () { return pick(list).z(); },
      place: function () {
        var e = pick(list);
        return JSON.stringify({ country: e.c, countryCode: e.k, city: pick(e.cities), postal: e.z() });
      }
    };
  });

  /* =========================================================================
     intl* — real localised data from the locales already inside the bundle.
     Each instance shares the main randomizer, so a fixed seed still
     reproduces every value exactly.
     ========================================================================= */
  var LOCALES = [
    { name: "Japan",         key: "Japan",         loc: F.ja },
    { name: "Germany",       key: "Germany",       loc: F.de },
    { name: "France",        key: "France",        loc: F.fr },
    { name: "Spain",         key: "Spain",         loc: F.es },
    { name: "Italy",         key: "Italy",         loc: F.it },
    { name: "Mexico",        key: "Mexico",        loc: F.es_MX },
    { name: "Brazil",        key: "Brazil",        loc: F.pt_BR },
    { name: "China",         key: "China",         loc: F.zh_CN },
    { name: "South Korea",   key: "Korea",         loc: F.ko },
    { name: "India",         key: "India",         loc: F.en_IN },
    { name: "United Kingdom",key: "UnitedKingdom", loc: F.en_GB },
    { name: "Canada",        key: "Canada",        loc: F.en_CA }
  ];

  function safe(fn, fallback) {
    try { var v = fn(); return (v === undefined || v === null) ? fallback : v; }
    catch (e) { return fallback; }
  }

  var INTL = LOCALES.filter(function (l) { return !!l.loc; }).map(function (l) {
    var inst = localeFaker(l.loc);
    var api = {
      fullName:      function () { return safe(function () { return inst.person.fullName(); }, ""); },
      city:          function () { return safe(function () { return inst.location.city(); }, ""); },
      streetAddress: function () { return safe(function () { return inst.location.streetAddress(); }, ""); },
      zipCode:       function () { return safe(function () { return inst.location.zipCode(); }, ""); },
      phone:         function () { return safe(function () { return inst.phone.number(); }, ""); },
      place: function () {
        return JSON.stringify({
          country: l.name,
          name: api.fullName(), street: api.streetAddress(),
          city: api.city(), postal: api.zipCode()
        });
      }
    };
    f["intl" + l.key] = api;
    return { name: l.name, api: api };
  });

  /* One field, a different country every row — the quickest way to get an
     international address set. Split place() with formulas. */
  f.intlAny = {
    country:  function () { return pick(INTL).name; },
    fullName: function () { return pick(INTL).api.fullName(); },
    city:     function () { return pick(INTL).api.city(); },
    place:    function () { return pick(INTL).api.place(); }
  };
})();
