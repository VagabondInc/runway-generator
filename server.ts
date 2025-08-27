// server.ts — Vercel/Node server for parsing Suno.com song pages
// Extracts song metadata from embedded JSON without requiring browser automation
// Package.json deps: { "fastify": "^4.26.2" }

import Fastify from "fastify";

const fastify = Fastify({ logger: false });

fastify.get("/parse", async (req, reply) => {
  const url = String((req.query as any)?.url || "");
  if (!url || !/^https?:\/\/(www\.)?suno\.com\/song\/[a-f0-9-]+$/i.test(url)) {
    reply.code(400).send({ error: "Provide a valid suno.com song URL at /song/<id>" });
    return;
  }

  try {
    // Fetch the HTML page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract JSON data from multiple possible script patterns
    let songData = null;
    let allScriptData = {};
    
    // Try __NEXT_DATA__ script (traditional Next.js)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData?.props?.pageProps;
        songData = pageProps?.song || pageProps?.data || pageProps;
        allScriptData.nextData = nextData;
      } catch (e) {
        // Continue to other extraction methods
      }
    }
    
    // Try Next.js App Router streaming format (self.__next_f.push)
    if (!songData) {
      const nextfMatches = html.match(/self\.__next_f\.push\(\[1,\s*"([^"]*(?:\\.[^"]*)*)"\]\)/g);
      if (nextfMatches) {
        for (const match of nextfMatches) {
          try {
            const jsonMatch = match.match(/self\.__next_f\.push\(\[1,\s*"([^"]*(?:\\.[^"]*)*)"\]\)/);
            if (jsonMatch && jsonMatch[1]) {
              const unescaped = jsonMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              
              // Look for the clip data structure that contains song info
              if (unescaped.includes('"clip":') && unescaped.includes('"status":"complete"')) {
                try {
                  const jsonData = JSON.parse(unescaped);
                  
                  // Look for nested song data in the clip structure
                  function findSongData(obj: any): any {
                    if (!obj || typeof obj !== 'object') return null;
                    
                    // Check if this is the clip object with song data
                    if (obj.clip && obj.clip.title && obj.clip.metadata) {
                      return obj.clip;
                    }
                    
                    // Check if this is a direct song object
                    if (obj.title && obj.metadata && (obj.audio_url || obj.id)) {
                      return obj;
                    }
                    
                    if (Array.isArray(obj)) {
                      for (const item of obj) {
                        const found = findSongData(item);
                        if (found) return found;
                      }
                    } else {
                      for (const key in obj) {
                        const found = findSongData(obj[key]);
                        if (found) return found;
                      }
                    }
                    return null;
                  }
                  
                  const nestedSong = findSongData(jsonData);
                  if (nestedSong) {
                    songData = nestedSong;
                    allScriptData.streamingData = jsonData;
                    break;
                  }
                } catch (e) {
                  // Continue searching
                }
              }
            }
          } catch (e) {
            // Continue to next match
          }
        }
      }
    }
    
    // Try other JSON script patterns that might contain song data
    const allScripts = html.match(/<script[^>]*>(.*?)<\/script>/gs) || [];
    for (const script of allScripts) {
      const jsonMatch = script.match(/<script[^>]*>([\s\S]*?)<\/script>/);
      if (jsonMatch && jsonMatch[1].trim().startsWith('{')) {
        try {
          const jsonData = JSON.parse(jsonMatch[1]);
          if (jsonData.title || jsonData.display_name || jsonData.metadata) {
            songData = jsonData;
            break;
          }
        } catch (e) {
          // Continue searching
        }
      }
    }
    
    // Fallback: Extract data using regex patterns
    let title = songData?.title || null;
    let artist = songData?.display_name || songData?.user?.display_name || null;
    let lyrics = songData?.metadata?.prompt || songData?.gpt_description_prompt || null;
    let styles = songData?.display_tags || songData?.metadata?.tags || null;
    
    // Extract negative_tags as style information when tags is empty
    if (!styles && songData?.metadata?.negative_tags) {
      // Convert negative tags to positive inference (what the song is NOT)
      const negTags = songData.metadata.negative_tags;
      styles = `NOT: ${negTags}`;
    }
    
    // Enhanced JSON data extraction from Next.js props
    if ((allScriptData as any).nextData?.props?.pageProps) {
      const props = (allScriptData as any).nextData.props.pageProps;
      if (props.song) {
        lyrics = lyrics || props.song.metadata?.prompt || props.song.gpt_description_prompt;
        styles = styles || props.song.metadata?.tags;
      }
    }
    
    // Extract lyrics from streaming data prompt references
    if (!lyrics && songData?.metadata?.prompt) {
      // Look for prompt reference like "$18" in the metadata
      const promptRef = songData.metadata.prompt;
      if (typeof promptRef === 'string' && promptRef.startsWith('$')) {
        const promptId = promptRef.substring(1); // Remove the $ prefix (e.g., "18")
        
        // Find all matches of the prompt pattern
        const promptPattern = new RegExp(`"${promptId}:T[a-f0-9]+,([\\s\\S]*?)(?="\]|$)`, 'g');
        const allMatches = [...html.matchAll(promptPattern)];
        
        for (const match of allMatches) {
          if (match[1]) {
            // Get the full chunk containing this match
            const matchStart = html.lastIndexOf('self.__next_f.push', match.index || 0);
            const matchEnd = html.indexOf('])', match.index || 0) + 2;
            const fullChunk = html.substring(matchStart, matchEnd);
            
            // Skip chunks that contain "clip" (these contain nested persona lyrics)
            if (!fullChunk.includes('"clip"')) {
              const content = match[1];
              // Basic validation that this looks like lyrics content
              if (content && content.length > 20) {
                lyrics = content.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_match: string, p1: string) => String.fromCharCode(parseInt(p1, 16))).trim();
                break;
              }
            }
          }
        }
      }
    }
    
    // Extract from meta tags and other HTML patterns
    if (!title) {
      // Try various title extraction methods
      const ogTitle = html.match(/<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\']+)["\'][^>]*>/);
      const twitterTitle = html.match(/<meta[^>]*name=["\']twitter:title["\'][^>]*content=["\']([^"\']+)["\'][^>]*>/);
      const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/);
      
      title = (ogTitle && ogTitle[1]) || (twitterTitle && twitterTitle[1]) || 
              (htmlTitle && htmlTitle[1].replace(' | Suno', '').trim()) || null;
    }
    
    if (!artist) {
      // Try to extract artist from meta description or other patterns
      const descMatch = html.match(/<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']*by\s+([^"\']+))["\'][^>]*>/);
      if (descMatch && descMatch[2]) {
        artist = descMatch[2].trim();
      }
    }
    
    if (!lyrics) {
      // Try multiple patterns for lyrics extraction
      const patterns = [
        /prompt["\']?\s*:\s*["\']([^"\']+)["\']/, // JSON prompt field
        /lyrics["\']?\s*:\s*["\']([^"\']+)["\']/, // JSON lyrics field
        /"gpt_description_prompt":\s*"([^"]*(?:\\.[^"]*)*)"/g, // GPT prompt with escapes
        /class=["\'][^"\']*lyrics[^"\']*["\'][^>]*>([^<]+)/, // CSS class
        /data-[^=]*lyrics[^=]*=["\']([^"\']+)["\']/, // Data attribute
        /"prompt":\s*"([^"]*(?:\\.[^"]*)*)"/g, // Escaped JSON prompt with proper handling
        /\[Verse[^\]]*\][\s\S]*?\[\/Verse\]/gi, // Verse blocks
        /\[Chorus[^\]]*\][\s\S]*?\[\/Chorus\]/gi, // Chorus blocks
        /(?:\[Verse\]|\[Chorus\]|\[Bridge\]|\[Outro\]|\[Intro\])[\s\S]*?(?=\[|$)/gi, // Any lyric sections
        /"([^"]*\[(?:Verse|Chorus|Bridge|Intro|Outro)[^\]]*\][\s\S]*?)"/, // Quoted lyric blocks
        /(?:^|\n)([A-Z][^.\n]*\[(?:Verse|Chorus|Bridge|Intro|Outro)[^\]]*\][\s\S]*?)(?:\n\n|$)/, // Plain text lyric blocks
        // More aggressive patterns for streaming data
        /\\u[0-9a-f]{4}.*?\[(?:Verse|Chorus|Bridge|Intro|Outro)[^\]]*\][\\s\\S]*?/gi,
        /"[^"]*(?:\[Verse\]|\[Chorus\]|\[Bridge\]|\[Intro\]|\[Outro\])[^"]*"/gi
      ];
      
      for (const pattern of patterns) {
        const matches = html.match(pattern);
        if (matches) {
          const matchArray = Array.isArray(matches) ? matches : [matches];
          for (const match of matchArray) {
            const lyricText = Array.isArray(match) ? match[1] : match;
            if (lyricText && lyricText.length > 20 && (lyricText.includes('[Verse') || lyricText.includes('[Chorus') || lyricText.includes('\\n') || lyricText.split('\n').length > 2)) {
              lyrics = lyricText.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\u([0-9a-f]{4})/gi, (_match: string, p1: string) => String.fromCharCode(parseInt(p1, 16))).trim();
              break;
            }
          }
          if (lyrics) break;
        }
      }
    }
    
    if (!styles) {
      // Try multiple patterns for style/genre extraction
      const patterns = [
        /tags["\']?\s*:\s*["\']([^"\']+)["\']/, // JSON tags field
        /style["\']?\s*:\s*["\']([^"\']+)["\']/, // JSON style field
        /genre["\']?\s*:\s*["\']([^"\']+)["\']/, // JSON genre field
        /class=["\'][^"\']*style[^"\']*["\'][^>]*>([^<]+)/, // CSS class
        /class=["\'][^"\']*tag[^"\']*["\'][^>]*>([^<]+)/, // Tag class
        /"tags":\s*"([^"]*(?:\\.[^"]*)*)"/g, // Escaped JSON tags with proper handling
        /"style":\s*"([^"]*(?:\\.[^"]*)*)"/g, // Escaped JSON style
        /"genre":\s*"([^"]*(?:\\.[^"]*)*)"/g, // Escaped JSON genre
        /(?:experimental|ballad|ambient|rock|pop|jazz|classical|electronic|hip-hop|country|folk|blues|r&b|reggae|metal|punk|indie|alternative|dance|house|techno|dubstep|trap|lo-fi|chillout|acoustic)[,\s]*(?:experimental|ballad|ambient|rock|pop|jazz|classical|electronic|hip-hop|country|folk|blues|r&b|reggae|metal|punk|indie|alternative|dance|house|techno|dubstep|trap|lo-fi|chillout|acoustic)[,\s]*(?:experimental|ballad|ambient|rock|pop|jazz|classical|electronic|hip-hop|country|folk|blues|r&b|reggae|metal|punk|indie|alternative|dance|house|techno|dubstep|trap|lo-fi|chillout|acoustic)?/gi // Common genre combinations
      ];
      
      for (const pattern of patterns) {
        const matches = html.match(pattern);
        if (matches) {
          for (const match of (Array.isArray(matches) ? matches : [matches])) {
            const styleText = Array.isArray(match) ? match[1] || match[0] : match;
            if (styleText && styleText.length > 2) {
              styles = styleText.replace(/\\"/g, '"').trim();
              break;
            }
          }
          if (styles) break;
        }
      }
      
      // Try to find style tags in meta descriptions
      if (!styles) {
        const metaDesc = html.match(/<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\']*)["\'][^>]*>/);
        if (metaDesc && metaDesc[1]) {
          const genreMatch = metaDesc[1].match(/(experimental|ballad|ambient|rock|pop|jazz|classical|electronic|hip-hop|country|folk|blues|r&b|reggae|metal|punk|indie|alternative|dance|house|techno|dubstep|trap|lo-fi|chillout|acoustic)/i);
          if (genreMatch) {
            styles = genreMatch[1];
          }
        }
      }
    }
    
    // Clean up extracted text
    function clean(s?: string | null) {
      return s
        ?.replace(/\u00a0/g, ' ')
        ?.replace(/<[^>]+>/g, '')
        ?.replace(/\s+/g, ' ')
        ?.replace(/\n{3,}/g, '\n\n')
        ?.trim() || null;
    }
    
    // Provide debug info
    const rawHtmlSnippet = html.slice(0, 2000);
    
    // Extract audio URL for transcription
    const audioUrl = songData?.audio_url || null;
    
    reply.send({
      url,
      title: clean(title),
      artist: clean(artist),
      lyrics: clean(lyrics),
      styles: clean(styles),
      audio_url: audioUrl,
      transcription_note: audioUrl ? "For accurate lyrics, consider using an LLM with audio transcription capabilities on the audio_url" : null,
      rawHtmlSnippet,
      songData: songData ? JSON.stringify(songData).slice(0, 500) : null, // Debug info
      debugInfo: {
        hasNextData: !!nextDataMatch,
        scriptCount: allScripts.length,
        htmlLength: html.length,
        foundPatterns: {
          title: !!title,
          artist: !!artist, 
          lyrics: !!lyrics,
          styles: !!styles,
          audio_url: !!audioUrl
        }
      }
    });
  } catch (err: any) {
    reply.code(500).send({ error: "Failed to fetch or parse page", details: err?.message });
  }
});

// Full JSON extraction endpoint
fastify.get("/extract", async (req, reply) => {
  const url = String((req.query as any)?.url || "");
  if (!url || !/^https?:\/\/(www\.)?suno\.com\/song\/[a-f0-9-]+$/i.test(url)) {
    reply.code(400).send({ error: "Provide a valid suno.com song URL at /song/<id>" });
    return;
  }

  try {
    // Fetch the HTML page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const html = await response.text();
    
    // Extract JSON data from multiple possible script patterns  
    let songData = null;
    let nextData = null;
    
    // Try __NEXT_DATA__ script
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (nextDataMatch) {
      try {
        nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData?.props?.pageProps;
        songData = pageProps?.song || pageProps?.data || pageProps;
      } catch (e) {
        // Continue to other extraction methods
      }
    }
    
    // Try other JSON script patterns
    const allScripts = html.match(/<script[^>]*>(.*?)<\/script>/gs) || [];
    if (!songData) {
      for (const script of allScripts) {
        const jsonMatch = script.match(/<script[^>]*>([\s\S]*?)<\/script>/);
        if (jsonMatch && jsonMatch[1].trim().startsWith('{')) {
          try {
            const jsonData = JSON.parse(jsonMatch[1]);
            if (jsonData.title || jsonData.display_name || jsonData.metadata) {
              songData = jsonData;
              break;
            }
          } catch (e) {
            // Continue searching
          }
        }
      }
    }
    
    if (!songData && !nextData) {
      reply.code(404).send({ error: "No song data found on page" });
      return;
    }
    
    // Extract and organize the data nicely
    const pageProps = nextData?.props?.pageProps;
    const song = pageProps?.song || pageProps?.data;
    
    // Structure the response with organized sections
    const organizedData = {
      url,
      extraction_timestamp: new Date().toISOString(),
      
      // Core song information
      song_info: {
        id: song?.id,
        title: song?.title,
        display_name: song?.display_name,
        created_at: song?.created_at,
        status: song?.status,
        model_name: song?.model_name,
        gpt_description_prompt: song?.gpt_description_prompt
      },
      
      // User/Artist information
      user_info: {
        id: song?.user?.id,
        display_name: song?.user?.display_name,
        handle: song?.user?.handle,
        avatar_image_url: song?.user?.avatar_image_url,
        is_verified: song?.user?.is_verified
      },
      
      // Audio and media URLs
      media: {
        audio_url: song?.audio_url,
        video_url: song?.video_url,
        image_url: song?.image_url,
        image_large_url: song?.image_large_url
      },
      
      // Metadata and generation details
      metadata: {
        prompt: song?.metadata?.prompt,
        gpt_description_prompt: song?.metadata?.gpt_description_prompt,
        audio_prompt_id: song?.metadata?.audio_prompt_id,
        history: song?.metadata?.history,
        concat_history: song?.metadata?.concat_history,
        type: song?.metadata?.type,
        duration: song?.metadata?.duration,
        refund_credits: song?.metadata?.refund_credits,
        stream: song?.metadata?.stream,
        error_type: song?.metadata?.error_type,
        error_message: song?.metadata?.error_message,
        tags: song?.metadata?.tags
      },
      
      // Engagement metrics
      engagement: {
        play_count: song?.play_count,
        upvote_count: song?.upvote_count,
        is_liked: song?.is_liked,
        reaction: song?.reaction
      },
      
      // Technical details
      technical: {
        duration: song?.duration,
        is_trashed: song?.is_trashed,
        is_public: song?.is_public,
        stem_from_id: song?.stem_from_id,
        infill_start_s: song?.infill_start_s,
        infill_end_s: song?.infill_end_s
      },
      
      // Raw Next.js data for debugging
      raw_next_data: {
        props: nextData?.props,
        page: nextData?.page,
        query: nextData?.query,
        buildId: nextData?.buildId,
        isFallback: nextData?.isFallback,
        gssp: nextData?.gssp
      },
      
      // Full song object
      full_song_data: song
    };
    
    reply.send(organizedData);
    
  } catch (err: any) {
    reply.code(500).send({ error: "Failed to fetch or extract data", details: err?.message });
  }
});

// Health and OpenAPI file passthrough if hosting spec here
fastify.get("/", async (_req, reply) => reply.send({ ok: true }));
fastify.get("/openapi.yaml", async (_req, reply) => {
  // If serving the spec from the same host, paste the YAML string here or read from file.
  reply.type("text/yaml").send(`# paste the openapi.yaml content here`);
});

fastify.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" }).catch((err) => {
  console.error(err);
  process.exit(1);
});