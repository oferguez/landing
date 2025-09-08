import React, { useState } from 'react';

const sources = {
  adjectives: "adjectives.txt",
  nouns: "nouns.txt",
  verbs: "verbs_no_fatverb.txt",
  he_IL: "he_IL.dic"
};

const BATCH_SIZE = 10000; // Process wordlists in batches to avoid stack overflow

const HEBREW_BLOCK = /[\u0590-\u05FF]/;
const HEBREW_LETTERS_CLASS = "[\\u0590-\\u05FF]";

function stripNiqqud(s) {
  return Array.from(s.normalize("NFKD")).filter(ch => !/\p{M}/u.test(ch)).join("");
}

function templateToRegex(template, wholeWord = true) {
  let out = "";
  let inClass = false;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (ch === "[" && !inClass) { inClass = true; out += ch; continue; }
    if (ch === "]" && inClass) { inClass = false; out += ch; continue; }
    if (inClass) { out += ch; continue; }
    if (ch === "?") { out += HEBREW_LETTERS_CLASS; continue; }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp((wholeWord ? "^" : "") + out + (wholeWord ? "$" : ""), "u");
}

async function loadWordlist(sourceKey, customUrl, pasted, opts) {
  let text = "";
  if (sourceKey === "custom") {
    if (pasted && pasted.trim().length) {
      text = pasted;
    } else if (customUrl && customUrl.trim().length) {
      const res = await fetch(customUrl.trim(), { cache: "no-store" });
      if (!res.ok) throw new Error("טעינת URL נכשלה: " + res.status);
      text = await res.text();
    } else {
      throw new Error("בחר/י מקור: URL או הדבקה ידנית");
    }
  } else {
    const url = sources[sourceKey];
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("טעינת מקור ברירת מחדל נכשלה: " + res.status);
    text = await res.text();
  }

  let words = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  words = words.filter(w => !/\s/.test(w) && HEBREW_BLOCK.test(w));

  if (opts.stripNiqqud) {
    // Process niqqud removal in batches to avoid stack overflow
    const processedWords = [];
    for (let i = 0; i < words.length; i += BATCH_SIZE) {
      const batch = words.slice(i, i + BATCH_SIZE);
      processedWords.push(...batch.map(stripNiqqud));
    }
    words = processedWords;
  }
  return words;
}

async function searchInWordlist(words, pattern, wholeWord, onProgress, letterConstraints = null) {
  const rx = templateToRegex(pattern, wholeWord);
  const matches = [];
  
  
  // Helper function to check letter constraints
  const passesLetterConstraints = (word) => {
    if (!letterConstraints) return true;
    
    const { selected, deselected } = letterConstraints;
    
    // Check that all selected letters appear in the word
    for (const letter of selected) {
      if (!word.includes(letter)) {
        return false;
      }
    }
    
    // Check that none of the deselected letters appear in the word
    for (const letter of deselected) {
      if (word.includes(letter)) {
        return false;
      }
    }
    
    return true;
  };
  
  if (words.length <= BATCH_SIZE) {
    // Small wordlist - process all at once
    return words.filter(w => rx.test(w) && passesLetterConstraints(w));
  }
  
  // Large wordlist - process in batches
  const totalBatches = Math.ceil(words.length / BATCH_SIZE);
  for (let i = 0; i < words.length; i += BATCH_SIZE) {
    const batch = words.slice(i, i + BATCH_SIZE);
    const batchMatches = batch.filter(w => rx.test(w) && passesLetterConstraints(w));
    matches.push(...batchMatches);
    
    if (onProgress) {
      const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
      onProgress(currentBatch, totalBatches);
    }
    
    // Allow UI to update between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  
  return matches;
}

async function loadAndSearchWordlists(sourceKeys, customWordlists, pattern, opts, onSourceStatus, onProgress, letterConstraints = null) {
  const allMatches = [];
  const allWordCounts = { total: 0, matched: 0 };
  
  // Process each source individually
  for (const sourceKey of sourceKeys) {
    try {
      if (onProgress) onProgress(`טוען ${sourceKey}...`);
      
      const words = await loadWordlist(sourceKey, null, null, opts);
      allWordCounts.total += words.length;
      
      if (onProgress) onProgress(`מחפש ב-${sourceKey}...`);
      
      const matches = await searchInWordlist(words, pattern, opts.wholeWord, 
        (currentBatch, totalBatches) => {
          if (onProgress) onProgress(`מחפש ב-${sourceKey} (חלק ${currentBatch}/${totalBatches})...`);
        },
        letterConstraints
      );
      
      allMatches.push(...matches);
      allWordCounts.matched += matches.length;
      
      if (onSourceStatus) onSourceStatus(sourceKey, 'success', words.length);
    } catch (e) {
      console.warn(`Failed to load ${sourceKey}:`, e);
      if (onSourceStatus) onSourceStatus(sourceKey, 'error', 0, e.message);
    }
  }
  
  // Process custom wordlists
  for (const customList of customWordlists) {
    if (onProgress) onProgress(`מחפש ב-${customList.name}...`);
    
    const matches = await searchInWordlist(customList.words, pattern, opts.wholeWord, null, letterConstraints);
    allMatches.push(...matches);
    allWordCounts.total += customList.words.length;
    allWordCounts.matched += matches.length;
  }
  
  // Remove duplicates if requested
  let finalMatches = allMatches;
  if (opts.unique) {
    if (onProgress) onProgress("מסיר כפילויות...");
    const seen = new Set();
    finalMatches = [];
    for (const word of allMatches) {
      if (!seen.has(word)) {
        seen.add(word);
        finalMatches.push(word);
      }
    }
    allWordCounts.matched = finalMatches.length;
  }
  
  return { matches: finalMatches, stats: allWordCounts };
}

function downloadTxt(lines, filename = "matches.txt") {
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Hebrew QWERTY keyboard layout
const HEBREW_KEYBOARD = [
  { row: 0, keys: ["'", "1-!", "2-@", "3-#", "4-$", "5-%", "6-^", "7-&", "8-*", "9-(", "0-)", "-", "="] },
  { row: 1, keys: ["ק", "ר", "א", "ט", "ו", "ן", "ם", "פ", "]", "[", "\\"] },
  { row: 2, keys: ["ש", "ד", "ג", "כ", "ע", "י", "ח", "ל", "ך", "ף", ",", "."] },
  { row: 3, keys: ["ז", "ס", "ב", "ה", "נ", "מ", "צ", "ת", "ץ"] }
];

// Extract only Hebrew letters for selection
const HEBREW_LETTERS = HEBREW_KEYBOARD.flatMap(row => 
  row.keys.filter(key => /^[א-ת]$/.test(key))
);

export const HebrewMatcher = ({ className }) => {
  const [pattern, setPattern] = useState("אהב?");
  const [selectedSources, setSelectedSources] = useState(["adjectives", "nouns", "verbs", "he_IL"]);
  const [customUrl, setCustomUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [customWordlists, setCustomWordlists] = useState([]);
  const [sourceStatus, setSourceStatus] = useState({});
  const [stripNiqqudFlag, setStripNiqqudFlag] = useState(true);
  const [unique, setUnique] = useState(true);
  const [sort, setSort] = useState(true);
  const [wholeWord, setWholeWord] = useState(true);
  const [status, setStatus] = useState("");
  const [matches, setMatches] = useState([]);
  const [stats, setStats] = useState({ total: 0, matched: 0, time: 0 });
  const [showLetterSelector, setShowLetterSelector] = useState(false);
  const [letterStates, setLetterStates] = useState({}); // 'selected', 'deselected', or undefined (grey)

  const handleSearch = async () => {
    if (!pattern) {
      alert("נא להזין תבנית");
      return;
    }

    if (selectedSources.length === 0 && customWordlists.length === 0 && !paste.trim()) {
      alert("נא לבחור לפחות מקור אחד");
      return;
    }

    setStatus("מתחיל חיפוש...");
    
    // Reset source status
    setSourceStatus({});
    
    try {
      const t0 = performance.now();
      
      // Create a custom wordlist from pasted text if provided
      const customFromPaste = paste.trim() ? [{ name: 'pasted', words: paste.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(w => !/\s/.test(w) && HEBREW_BLOCK.test(w)) }] : [];
      
      const handleSourceStatus = (sourceKey, status, count, error) => {
        setSourceStatus(prev => ({
          ...prev,
          [sourceKey]: { status, count, error }
        }));
      };
      
      const handleProgress = (message) => {
        setStatus(message);
      };
      
      const searchOpts = {
        stripNiqqud: stripNiqqudFlag,
        unique: unique,
        wholeWord: wholeWord
      };
      
      // Prepare letter constraints
      const { selected, deselected } = getSelectedDeselectedSummary();
      const letterConstraints = (selected.length > 0 || deselected.length > 0) ? { selected, deselected } : null;
      
      const { matches: results, stats: searchStats } = await loadAndSearchWordlists(
        selectedSources, 
        [...customWordlists, ...customFromPaste], 
        pattern,
        searchOpts, 
        handleSourceStatus,
        handleProgress,
        letterConstraints
      );
      
      let finalResults = results;
      if (sort) {
        setStatus("מיין תוצאות...");
        finalResults.sort((a, b) => a.localeCompare(b));
      }
      
      const t1 = performance.now();

      setMatches(finalResults);
      setStats({ total: searchStats.total, matched: searchStats.matched, time: t1 - t0 });
      setStatus("בוצע.");
    } catch (e) {
      console.error(e);
      setStatus("שגיאה: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  const handleDownload = () => {
    if (!matches.length) {
      alert("אין תוצאות להורדה");
      return;
    }
    downloadTxt(matches, "matches.txt");
  };

  const handleLetterClick = (letter, isRightClick) => {
    setLetterStates(prev => {
      const current = prev[letter];
      let newState;
      
      if (isRightClick) {
        // Right click: grey -> red -> grey
        newState = current === 'deselected' ? undefined : 'deselected';
      } else {
        // Left click: grey -> green -> grey  
        newState = current === 'selected' ? undefined : 'selected';
      }
      
      const newStates = { ...prev };
      if (newState === undefined) {
        delete newStates[letter];
      } else {
        newStates[letter] = newState;
      }
      return newStates;
    });
  };

  const getSelectedDeselectedSummary = () => {
    const selected = Object.entries(letterStates)
      .filter(([, state]) => state === 'selected')
      .map(([letter]) => letter);
    const deselected = Object.entries(letterStates)
      .filter(([, state]) => state === 'deselected')
      .map(([letter]) => letter);
    
    return { selected, deselected };
  };

  const handleDownloadFromUrl = async () => {
    if (!customUrl.trim()) {
      alert("נא להזין כתובת URL");
      return;
    }

    setStatus("מוריד רשימת מילים מ-URL...");
    try {
      const res = await fetch(customUrl.trim(), { cache: "no-store" });
      if (!res.ok) throw new Error("טעינת URL נכשלה: " + res.status);
      const text = await res.text();
      
      let words = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      words = words.filter(w => !/\s/.test(w) && HEBREW_BLOCK.test(w));
      
      if (words.length === 0) {
        alert("לא נמצאו מילים עבריות תקינות ב-URL");
        setStatus("");
        return;
      }

      // Create a name for the wordlist based on URL
      const urlName = customUrl.split('/').pop() || 'custom_wordlist';
      const newWordlist = {
        name: urlName,
        words: words,
        url: customUrl
      };

      setCustomWordlists([...customWordlists, newWordlist]);
      setCustomUrl(""); // Clear the input
      setStatus(`הורד בהצלחה: ${words.length} מילים מ-${urlName}`);
    } catch (e) {
      console.error(e);
      setStatus("שגיאה בהורדה: " + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className={className} dir="rtl" lang="he">
      <div className="wrap">
        <div className="card">
          <h1>חיפוש מילים לפי תבנית (עברית)</h1>
          <p className="muted">
            השתמש/י ב-<span className="kbd">?</span> לאות עברית אחת. כל שאר התווים נלקחים ככתיבתם.
            לדוגמה: <span className="kbd">ר?וא?</span> → <span className="hint">ר</span> + אות כלשהי + <span className="hint">ו</span> + <span className="hint">א</span> + אות כלשהי.
            אפשר גם מחלקת תווים: <span className="kbd">[אי]</span>. עוגנים <span className="kbd">^</span> ו-<span className="kbd">$</span> ניתנים אוטומטית.
          </p>

          <div className="row row-2">
            <div>
              <label htmlFor="pattern">תבנית לחיפוש</label>
              <input 
                id="pattern" 
                placeholder="לדוגמה: ר?וא?" 
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
            </div>
            <div>
              <label>מקורות מילים (בחר/י אחד או יותר)</label>
              <div className="source-checkboxes" style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                <label className="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={selectedSources.includes('adjectives')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSources([...selectedSources, 'adjectives']);
                      } else {
                        setSelectedSources(selectedSources.filter(s => s !== 'adjectives'));
                      }
                    }}
                  />
                  <span>eyaler: adjectives.txt</span>
                  {sourceStatus.adjectives?.status === 'error' && (
                    <span style={{ color: '#ef4444', fontSize: '12px' }}>⚠️ לא זמין</span>
                  )}
                  {sourceStatus.adjectives?.status === 'success' && (
                    <span style={{ color: '#10b981', fontSize: '12px' }}>✓ {sourceStatus.adjectives.count.toLocaleString()}</span>
                  )}
                </label>
                <label className="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={selectedSources.includes('nouns')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSources([...selectedSources, 'nouns']);
                      } else {
                        setSelectedSources(selectedSources.filter(s => s !== 'nouns'));
                      }
                    }}
                  />
                  <span>eyaler: nouns.txt</span>
                  {sourceStatus.nouns?.status === 'error' && (
                    <span style={{ color: '#ef4444', fontSize: '12px' }}>⚠️ לא זמין</span>
                  )}
                  {sourceStatus.nouns?.status === 'success' && (
                    <span style={{ color: '#10b981', fontSize: '12px' }}>✓ {sourceStatus.nouns.count.toLocaleString()}</span>
                  )}
                </label>
                <label className="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={selectedSources.includes('verbs')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSources([...selectedSources, 'verbs']);
                      } else {
                        setSelectedSources(selectedSources.filter(s => s !== 'verbs'));
                      }
                    }}
                  />
                  <span>eyaler: verbs_no_fatverb.txt</span>
                  {sourceStatus.verbs?.status === 'error' && (
                    <span style={{ color: '#ef4444', fontSize: '12px' }}>⚠️ לא זמין</span>
                  )}
                  {sourceStatus.verbs?.status === 'success' && (
                    <span style={{ color: '#10b981', fontSize: '12px' }}>✓ {sourceStatus.verbs.count.toLocaleString()}</span>
                  )}
                </label>
                <label className="checkbox-label">
                  <input 
                    type="checkbox" 
                    checked={selectedSources.includes('he_IL')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSources([...selectedSources, 'he_IL']);
                      } else {
                        setSelectedSources(selectedSources.filter(s => s !== 'he_IL'));
                      }
                    }}
                  />
                  <span>he_IL</span>
                  {sourceStatus.he_IL?.status === 'error' && (
                    <span style={{ color: '#ef4444', fontSize: '12px' }}>⚠️ לא זמין</span>
                  )}
                  {sourceStatus.he_IL?.status === 'success' && (
                    <span style={{ color: '#10b981', fontSize: '12px' }}>✓ {sourceStatus.he_IL.count.toLocaleString()}</span>
                  )}
                </label>
                {customWordlists.map((customList, index) => (
                  <label key={index} className="checkbox-label">
                    <input type="checkbox" checked={true} readOnly />
                    <span>מורד: {customList.name}</span>
                    <button 
                      type="button" 
                      onClick={() => setCustomWordlists(customWordlists.filter((_, i) => i !== index))}
                      style={{ marginRight: '8px', fontSize: '12px', padding: '2px 6px' }}
                    >
                      הסר
                    </button>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="row row-2" style={{ marginTop: '12px' }}>
            <div>
              <label htmlFor="customUrl">הורד רשימת מילים מ-URL</label>
              <input 
                id="customUrl" 
                placeholder="https://raw.githubusercontent.com/.../words.txt"
                value={customUrl}
                onChange={(e) => setCustomUrl(e.target.value)}
              />
              <button 
                type="button" 
                onClick={handleDownloadFromUrl} 
                disabled={!customUrl.trim()}
                style={{ marginTop: '4px', fontSize: '14px' }}
              >
                הורד ושמור מקומי
              </button>
              <div className="small">הקובץ צריך להיות TXT, מילה אחת בכל שורה. שים/י לב ל-CORS.</div>
            </div>
            <div>
              <label htmlFor="paste">או הדבקה ידנית של רשימת מילים</label>
              <textarea 
                id="paste" 
                rows={4} 
                placeholder="מילה אחת בכל שורה"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
              />
            </div>
          </div>

          <div className="chips">
            דגלים:
            <label className="chip">
              <input type="checkbox" checked={stripNiqqudFlag} onChange={(e) => setStripNiqqudFlag(e.target.checked)} /> הסר ניקוד
            </label>
            <label className="chip">
              <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> הסר כפילויות
            </label>
            <label className="chip">
              <input type="checkbox" checked={sort} onChange={(e) => setSort(e.target.checked)} /> מיין תוצאות
            </label>
            <label className="chip">
              <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> התאמה למילה שלמה
            </label>
          </div>

          <div style={{ marginTop: '14px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button onClick={handleDownload} className="btn">הורד תוצאות (TXT)</button>
            <button onClick={() => setShowLetterSelector(true)} className="btn">בחירת אותיות</button>
            <span className="small">{status}</span>
          </div>
          
          {/* Letter Constraints Display */}
          {(() => {
            const { selected, deselected } = getSelectedDeselectedSummary();
            if (selected.length > 0 || deselected.length > 0) {
              return (
                <div className="letter-constraints-display">
                  {selected.length > 0 && (
                    <>
                      <span className="constraint-label">חייבות להופיע:</span> 
                      <span className="selected-letters-display">{selected.join(', ')}</span>
                      <span>     |     </span>
                    </>
                  )}
                  {deselected.length > 0 && (
                    <>
                      <span className="constraint-label">לא יופיעו:</span> 
                      <span className="deselected-letters-display">{deselected.join(', ')}</span>
                    </>
                  )}
                </div>
              );
            }
            return null;
          })()}

          {/* Dominant Search Button */}
          <div className="search-button-container">
            <button onClick={handleSearch} className="btn primary search-btn-dominant">
              🔍 חיפוש
            </button>
          </div>
          
          {/* Letter Selector Dialog */}
          {showLetterSelector && (
            <div className="letter-dialog-overlay" onClick={() => setShowLetterSelector(false)}>
              <div className="letter-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="letter-dialog-header">
                  <h3>בחירת אותיות</h3>
                  <button 
                    className="letter-dialog-close" 
                    onClick={() => setShowLetterSelector(false)}
                  >
                    ×
                  </button>
                </div>
                
                <div className="letter-instructions">
                  <p><strong>לחיצה שמאלית:</strong> אות חייבת להופיע (ירוק)</p>
                  <p><strong>לחיצה ימנית:</strong> אות לא מופיעה (אדום)</p>
                  <p><strong>אפור:</strong> אין הגבלה על האות</p>
                </div>
                
                <div className="hebrew-keyboard">
                  {HEBREW_KEYBOARD.map((row, rowIndex) => (
                    <div key={rowIndex} className="keyboard-row">
                      {row.keys.map((key, keyIndex) => {
                        const isHebrewLetter = /^[\u05d0-\u05ea]$/.test(key);
                        if (!isHebrewLetter) {
                          return (
                            <div key={keyIndex} className="keyboard-key disabled">
                              {key}
                            </div>
                          );
                        }
                        
                        const state = letterStates[key];
                        const className = `keyboard-key ${
                          state === 'selected' ? 'selected' : 
                          state === 'deselected' ? 'deselected' : 
                          'neutral'
                        }`;
                        
                        return (
                          <div 
                            key={keyIndex}
                            className={className}
                            onClick={(e) => {
                              e.preventDefault();
                              handleLetterClick(key, false);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              handleLetterClick(key, true);
                            }}
                          >
                            {key}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                
                {(() => {
                  const { selected, deselected } = getSelectedDeselectedSummary();
                  return (
                    <div className="letter-summary">
                      {selected.length > 0 && (
                        <div>אותיות שחייבות להופיע: <span className="selected-letters">{selected.join(', ')}</span></div>
                      )}
                      {deselected.length > 0 && (
                        <div>אותיות שלא יופיעו: <span className="deselected-letters">{deselected.join(', ')}</span></div>
                      )}
                      {selected.length === 0 && deselected.length === 0 && (
                        <div className="muted">לא נבחרו הגבלות אותיות</div>
                      )}
                    </div>
                  );
                })()}
                
                <div className="letter-dialog-actions">
                  <button 
                    onClick={() => setLetterStates({})}
                    className="btn"
                  >
                    נקה הכל
                  </button>
                  <button 
                    onClick={() => setShowLetterSelector(false)}
                    className="btn primary"
                  >
                    סגור
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="card" style={{ marginTop: '16px' }}>
          <div className="stats">
            <div>מילים נטענו: <strong>{stats.total.toLocaleString()}</strong></div>
            <div>התאמות: <strong>{stats.matched.toLocaleString()}</strong></div>
            <div>זמן חיפוש: <strong>{stats.time.toFixed(1)}ms</strong></div>
          </div>
          <div className="grid" style={{ marginTop: '12px' }}>
            {matches.map((match, index) => (
              <div key={index} className="result">{match}</div>
            ))}
          </div>
        </div>

        <p className="small" style={{ marginTop: '12px' }}>
          ברירות מחדל נטענות מ-<a href="https://github.com/eyaler/hebrew_wordlists" target="_blank" rel="noopener">eyaler/hebrew_wordlists</a>.
        </p>
      </div>
    </div>
  );
};