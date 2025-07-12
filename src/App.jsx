// App.jsx
import React, { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const App = () => {
  const mapContainer = useRef(null);
  const map = useRef(null);

  const [geojsonData, setGeojsonData] = useState(null);
  const [showAbout, setShowAbout] = useState(false);

  const fetchWikipediaSummary = async (title) => {
    const urlTitle = encodeURIComponent(title.replace(/^.*wiki\//, ''));
    const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${urlTitle}`);
    if (!response.ok) throw new Error('Failed to fetch preview');
    return response.json();
  };

  const formatDate = (isoDate) => {
    if (!isoDate || typeof isoDate !== 'string') return 'Unknown';
    try {
      const clean = isoDate.replace(/^\+/, '').replace(/T00:00:00Z$/, '');

      // Handle year-only or year-month only
      const parts = clean.split('-');
      if (parts.length === 1) return parts[0];
      if (parts.length === 2) {
        const date = new Date(`${clean}-01`);
        return date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'long',
        });
      }

      const date = new Date(clean);
      const showTime = !(date.getUTCHours() === 0 && date.getUTCMinutes() === 0);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }) + (showTime
        ? `, ${date.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          })}`
        : '');
    } catch {
      return isoDate;
    }
  };

  useEffect(() => {
    fetch('/events_0.1.json')
      .then((res) => res.json())
      .then((events) => {
        const features = events.flatMap((event) => {
          try {
            const coordsList = event.coords || (event.locations?.map(loc => loc.coords).filter(Boolean) ?? []);
            const formattedDate = formatDate(event.date?.point_in_time);

            return coordsList.map((coord) => ({
              type: 'Feature',
              properties: {
                title: event.label || event.title || 'Untitled',
                description: event.wikipedia_url || '',
                date: formattedDate || 'Unknown',
              },
              geometry: {
                type: 'Point',
                coordinates: [coord.lon, coord.lat],
              },
            }));
          } catch (err) {
            console.warn('Skipping invalid event:', event, err);
            return [];
          }
        });

        setGeojsonData({ type: 'FeatureCollection', features });
      })
      .catch((err) => {
        console.error('Error loading events.json:', err);
      });
  }, []);

  useEffect(() => {
    if (map.current) return;

    try {
      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: 'https://tiles.basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
        center: [0, 20],
        zoom: 2,
      });
    } catch (err) {
      console.error('Error initializing map:', err);
    }
  }, []);

  useEffect(() => {
    if (!map.current || !geojsonData) return;

    const addClusterLayers = () => {
      try {
        if (map.current.getSource('events')) {
          map.current.getSource('events').setData(geojsonData);
          return;
        }

        map.current.addSource('events', {
          type: 'geojson',
          data: geojsonData,
          cluster: true,
          clusterMaxZoom: 14,
          clusterRadius: 30,
        });

        map.current.addLayer({
          id: 'clusters',
          type: 'circle',
          source: 'events',
          filter: ["all", ["has", "point_count"], [">", ["get", "point_count"], 6]],
          paint: {
            'circle-color': '#51bbd6',
            'circle-radius': ['step', ['get', 'point_count'], 15, 100, 25, 750, 35],
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fff',
          },
        });

        map.current.addLayer({
          id: 'cluster-count',
          type: 'symbol',
          source: 'events',
          filter: ["all", ["has", "point_count"], [">", ["get", "point_count"], 6]],
          layout: {
            'text-field': '{point_count_abbreviated}',
            'text-size': 12,
          },
        });

        map.current.addLayer({
          id: 'unclustered-point',
          type: 'circle',
          source: 'events',
          filter: ['!', ['has', 'point_count']],
          paint: {
            'circle-color': '#f28cb1',
            'circle-radius': 6,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#fff',
          },
        });

        map.current.on('click', 'unclustered-point', async (e) => {
          const coordinates = e.features[0].geometry.coordinates.slice();
          const { title, description, date } = e.features[0].properties;

          if (!description) {
            new maplibregl.Popup()
              .setLngLat(coordinates)
              .setHTML(`<h3>${title}</h3><p>${date}</p><p>No Wikipedia link.</p>`)
              .addTo(map.current);
            return;
          }

          try {
            const preview = await fetchWikipediaSummary(description);
            new maplibregl.Popup()
              .setLngLat(coordinates)
              .setHTML(`
                <h3>${title}</h3>
                <p>${date}</p>
                <p><strong>${preview.title}</strong></p>
                ${preview.thumbnail ? `<img src="${preview.thumbnail.source}" alt="${preview.title}" style="max-width:100%;height:auto;"/>` : ''}
                <p>${preview.extract}</p>
                <a href="${preview.content_urls.desktop.page}" target="_blank" rel="noopener noreferrer">Read more on Wikipedia</a>
              `)
              .addTo(map.current);
          } catch (err) {
            console.error('Preview fetch error:', err);
            new maplibregl.Popup()
              .setLngLat(coordinates)
              .setHTML(`<h3>${title}</h3><p>${date}</p><a href="${description}" target="_blank">View on Wikipedia</a> (preview unavailable)`)
              .addTo(map.current);
          }
        });

        map.current.on('click', 'clusters', (e) => {
          const features = map.current.queryRenderedFeatures(e.point, {
            layers: ['clusters'],
          });
          const clusterId = features[0].properties.cluster_id;
          map.current.getSource('events').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.current.easeTo({
              center: features[0].geometry.coordinates,
              zoom,
            });
          });
        });

        map.current.on('mouseenter', 'clusters', () => {
          map.current.getCanvas().style.cursor = 'pointer';
        });
        map.current.on('mouseleave', 'clusters', () => {
          map.current.getCanvas().style.cursor = '';
        });
      } catch (err) {
        console.error('Error adding cluster layers:', err);
      }
    };

    if (map.current.loaded()) {
      addClusterLayers();
    } else {
      map.current.on('load', addClusterLayers);
    }
  }, [geojsonData]);

  return (
    <>

      <Helmet>
        <title>What Happened Here?</title>
        <meta name="description" content="An interactive world map of historical events through time and place. Every event with a wikipedia page and an associated location is mapped." />
        <meta name="keywords" content="history, world map, historical events, timeline, geography, interactive map, wikipedia" />
        <meta property="og:title" content="What Happened Here?" />
        <meta property="og:description" content="An interactive world map of historical events through time and place. Every event with a wikipedia page and an associated location is mapped." />
        <meta property="og:image" content="/preview.png" />
        <meta property="og:type" content="website" />
        {/* <meta property="og:url" content="https://yourdomain.com" /> */}
        {/* <meta name="twitter:card" content="summary_large_image" /> */}
        <link rel="icon" href="/favicon.ico" type="image/x-icon" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Helmet>

      <header style={{
        position: 'absolute',
        top: 0,
        width: '100%',
        background: 'rgba(255, 255, 255, 0.95)',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '12px 16px',
        fontWeight: 'bold',
        boxShadow: '1px 2px 4px rgba(0,0,0,0.1)',
        boxSizing: 'border-box',
        gap: '8px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flex: '1 1 auto', minWidth: 0 }}>
          <img src="/logo.png" alt="Historical Event Map Logo" style={{ height: '28px', marginRight: '10px', flexShrink: 0 }} />
          <span style={{
            fontSize: '1rem',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            maxWidth: '100%'
          }}>
            Historical Event Map — Explore the past by location
          </span>
        </div>
        <button
          onClick={() => setShowAbout(true)}
          style={{
            fontSize: '0.9rem',
            padding: '6px 10px',
            flexShrink: 0,
            whiteSpace: 'nowrap'
          }}
        >
          About
        </button>
      </header>

      {showAbout && (
        <div style={{
          position: 'absolute',
          top: '60px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'white',
          padding: '20px',
          borderRadius: '8px',
          maxWidth: '600px',
          zIndex: 3,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}>
          <h2>About This Map</h2>
          <p>
            This interactive map visualizes important historical events around the world based on publicly available data.
            It uses clustering to handle large volumes of information, and lets you explore the past through space and time.
          </p>
          <p>
            Data is sourced from structured sources such as Wikidata and processed to extract location and date information.
          </p>
          <button onClick={() => setShowAbout(false)} style={{ marginTop: '1rem' }}>Close</button>
        </div>
      )}

      <div
        ref={mapContainer}
        style={{
          position: 'absolute',
          top: '0px', // match the header height
          bottom: 0,
          width: '100%',
        }}
      />

    </>
  );
};

export default App;
