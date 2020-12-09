/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {getReport, getSegmentNameById} from './api.js';
import {WebVitalsError} from './utils.js';


export function getDefaultOpts() {
  return {
    active: false,
    metricNameDim: 'ga:eventAction',
    metricIdDim: 'ga:eventLabel',
    lcpName: 'LCP',
    fidName: 'FID',
    clsName: 'CLS',
    filters: '',
  };
}

function getViewOpts(state) {
  const stateOpts = state[`opts:${state.viewId}`];
  return stateOpts && stateOpts.active ? stateOpts : getDefaultOpts();
}


export async function getWebVitalsData(state) {
  const reportRequest = buildReportRequest(state);
  const report = await getReport(reportRequest);

  const opts = getViewOpts(state);
  const metricNameMap = {
    [opts.lcpName]: 'LCP',
    [opts.fidName]: 'FID',
    [opts.clsName]: 'CLS',
  };

  if (report.length === 0) {
    throw new WebVitalsError({
      title: 'No Web Vitals events found...',
      message: [
        'It looks like no Web Vitals data has been sent to this Google',
        'Analytics account. You can learn how to measure and send Web Vitals',
        'data here: https://github.com/GoogleChrome/web-vitals',
      ].join(' '),
    });
  }

  const getSegmentsObj = (getDefaultValue = () => []) => {
    const segmentIdA = reportRequest.segments[0].segmentId.slice(6);
    const segmentIdB = reportRequest.segments[1].segmentId.slice(6);
    return {
      [getSegmentNameById(segmentIdA)]: getDefaultValue(),
      [getSegmentNameById(segmentIdB)]: getDefaultValue(),
    };
  };

  const getMetricsObj = (getDefaultValue = getSegmentsObj) => {
    return {
      LCP: getDefaultValue(),
      FID: getDefaultValue(),
      CLS: getDefaultValue(),
    };
  };

  const incrementCount = (obj) => {
    if (!Object.prototype.hasOwnProperty.call(obj, 'count')) {
      Object.defineProperty(obj, 'count', {writable: true, value: 0});
    }
    obj.count++;
  };

  const data = {
    metrics: getMetricsObj(() => {
      return {values: [], segments: getSegmentsObj(), dates: {}};
    }),
    countries: [],
    pages: [],
  };

  for (const row of report) {
    let value = Number(row.metrics[0].values[0]);
    let [segmentId, date, metric, country, page] = row.dimensions;
    const segment = getSegmentNameById(segmentId);

    // Convert the metric from any custom name to the standard name.
    metric = metricNameMap[metric];

    // CLS is sent to Google Analytics at 1000x for greater precision.
    if (metric === 'CLS') {
      value = value / 1000;
    }

    // Even though the report limits `metric` values to LCP, FID, and CLS,
    // for reports with more than a million rows of data, Google Analytics
    // will aggregate everything after the first million rows into and "(other)"
    // bucket, which skews the data and makes the report useless.
    // The only solution to this is to make more granular requests (e.g.
    // reduce the date range or add filters) and manually combine the data
    // yourself.
    if (metric !== 'LCP' && metric !== 'FID' && metric !== 'CLS') {
      throw new Error(`Error: unexpected metric '${metric}' found.`);
    }

    const metricData = data.metrics[metric];
    metricData.values.push(value);

    // Breakdown by segment.
    metricData.segments[segment] = metricData.segments[segment] || [];
    metricData.segments[segment].push(value);

    // Breakdown by date.
    metricData.dates[date] = metricData.dates[date] || getSegmentsObj();
    metricData.dates[date][segment].push(value);

    // Breakdown by page.
    data.pages[page] = data.pages[page] || getMetricsObj();
    data.pages[page][metric][segment].push(value);
    incrementCount(data.pages[page]);

    // Breakdown by country.
    data.countries[country] = data.countries[country] || getMetricsObj();
    data.countries[country][metric][segment].push(value);
    incrementCount(data.countries[country]);
  }

  // Sort data
  function sortObjByCount(obj) {
    const newObj = {};
    const sortedKeys =
        Object.keys(obj).sort((a, b) => obj[b].count - obj[a].count);

    for (const key of sortedKeys) {
      newObj[key] = obj[key];
    }
    return newObj;
  }

  // Sort data by count.
  data.countries = sortObjByCount(data.countries);
  data.pages = sortObjByCount(data.pages);

  return data;
}

function parseFilters(filtersExpression) {
  if (filtersExpression.match(/[^\\],/)) {
    throw new Error([
      'OR based filter expressions (using a comma) are not supported.',
      'Only AND based filter expressions (using a semicolon) are allowed.',
    ].join());
  }

  // TODO: add support for escaping semicolons.
  return filtersExpression.split(';').map((expression) => {
    const match = /(ga:\w+)([!=][=@~])(.+)$/.exec(expression);
    if (!match) {
      throw new Error(`Invalid filter expression '${expression}'`);
    }

    const filter = {
      dimensionName: match[1],
      expressions: [match[3]],
    };

    if (match[2].startsWith('!')) {
      filter.not = true;
    }

    if (match[2].endsWith('=')) {
      filter.operator = 'EXACT';
    } else if (match[2].endsWith('@')) {
      filter.operator = 'PARTIAL';
    } else if (match[3].endsWith('~')) {
      filter.operator = 'REGEXP';
    }
    return filter;
  });
}

function buildReportRequest(state) {
  const {viewId, startDate, endDate, segmentA, segmentB} = state;
  const opts = getViewOpts(state);

  let filters = [
    {
      dimensionName: opts.metricNameDim,
      operator: 'IN_LIST',
      expressions: [opts.lcpName, opts.fidName, opts.clsName],
    },
  ];

  if (opts.filters) {
    filters = filters.concat(parseFilters(opts.filters));
  }

  return {
    viewId,
    pageSize: 100000,
    includeEmptyRows: true,
    dateRanges: [{startDate, endDate}],
    segments: [
      {segmentId: `gaid::${segmentA}`},
      {segmentId: `gaid::${segmentB}`},
    ],
    metrics: [{expression: 'ga:eventValue'}],
    dimensions: [
      {name: 'ga:segment'},
      {name: 'ga:date'},
      {name: opts.metricNameDim}, // Metric name (ga:eventAction)
      {name: 'ga:country'},
      {name: 'ga:pagePath'},
      {name: opts.metricIdDim}, // Unique metric ID (ga:eventLabel)
    ],
    dimensionFilterClauses: {
      operator: 'AND',
      filters,
    },
    orderBys: [
      {
        fieldName: 'ga:eventValue',
        sortOrder: 'ASCENDING',
      },
      {
        fieldName: 'ga:date',
        sortOrder: 'ASCENDING',
      },
    ],
  };
}
