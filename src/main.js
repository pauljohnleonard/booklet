import muhammara from "muhammara";
import fs from "fs";
import path from "path";
import imageSize from "image-size"; // npm install image-size
import { PDFDocument } from "pdf-lib"; // npm install pdf-lib

// Ensure output folder exists early
if (!fs.existsSync("booklets")) {
  fs.mkdirSync("booklets", { recursive: true });
}

const instruments = [
  { file: "Flute", title: "C" },
  { file: "Clarinet_in_Bb", title: "Bb" },
];

// Escape instrument for safe use in RegExp
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Group images into the fewest page-sets using a hybrid strategy:
// - Best-Fit Decreasing (fast heuristic)
// - Exact per-page 0/1 knapsack (pseudo-polynomial) to tightly fill each page
// Returns the better result (fewest pages; tie-break by least slack).
function groupImagesIntoPages(images, contentHeight, scale, imageGap) {
  // Prepare items with scaled height
  const items = images.map((img, idx) => ({
    ...img,
    _idx: idx,
    scaledHeight: img.height * scale,
  }));

  // Helper: convert packed pages (arrays of items with helpers) to original shape
  const stripHelpers = (pages) =>
    pages.map((p) => p.map(({ scaledHeight, _idx, ...rest }) => rest));

  // Heuristic 1: Best-Fit Decreasing
  function packWithBFD(itemsList, capacity, gap) {
    const sorted = itemsList
      .slice()
      .sort((a, b) => b.scaledHeight - a.scaledHeight);
    const pages = []; // each: { items: [], used: number }
    for (const it of sorted) {
      let bestIdx = -1;
      let bestResidual = Infinity;
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const needed = (page.used > 0 ? gap : 0) + it.scaledHeight;
        if (page.used + needed <= capacity) {
          const residual = capacity - (page.used + needed);
          if (residual < bestResidual) {
            bestResidual = residual;
            bestIdx = i;
          }
        }
      }
      if (bestIdx === -1) {
        pages.push({ items: [it], used: it.scaledHeight });
      } else {
        const page = pages[bestIdx];
        page.items.push(it);
        page.used += (page.used > 0 ? gap : 0) + it.scaledHeight;
      }
    }
    return pages.map((p) => p.items);
  }

  // Heuristic 2: Per-page 0/1 knapsack (exact for a given page)
  function packWithKnapsack(itemsList, capacity, gap) {
    const pages = [];

    // Oversized items (higher than the available vertical space) get their own page
    const oversized = itemsList.filter((it) => it.scaledHeight > capacity);
    const rest = itemsList.filter((it) => it.scaledHeight <= capacity);
    for (const it of oversized) {
      pages.push([it]);
    }

    // Knapsack trick:
    //   weight(item) = h_i + gap
    //   capacity'    = capacity + gap
    // So any subset with sum(w_i) <= capacity' implies sum(h_i) + (k-1)*gap <= capacity.
    const capW = Math.floor(capacity + gap); // floor for safety
    while (rest.length > 0) {
      const n = rest.length;
      const weights = rest.map((it) => Math.ceil(it.scaledHeight + gap)); // ceil for safety
      const values = rest.map((it) => Math.floor(it.scaledHeight)); // maximize used height

      // dpVal[w] = best value at weight <= w; dpSet[w] = indices chosen to reach dpVal[w]
      const dpVal = new Array(capW + 1).fill(-1);
      const dpSet = new Array(capW + 1).fill(null);
      dpVal[0] = 0;
      dpSet[0] = [];

      for (let i = 0; i < n; i++) {
        const wi = weights[i];
        const vi = values[i];
        for (let w = capW; w >= wi; w--) {
          if (dpVal[w - wi] !== -1) {
            const cand = dpVal[w - wi] + vi;
            if (cand > dpVal[w]) {
              dpVal[w] = cand;
              dpSet[w] = dpSet[w - wi].concat(i);
            } else if (cand === dpVal[w]) {
              const candSet = dpSet[w - wi].concat(i);
              if (!dpSet[w] || candSet.length > dpSet[w].length) {
                dpSet[w] = candSet;
              }
            }
          }
        }
      }

      // Pick the best filled weight
      let bestW = 0;
      let bestVal = -1;
      for (let w = 0; w <= capW; w++) {
        if (dpVal[w] > bestVal) {
          bestVal = dpVal[w];
          bestW = w;
        }
      }

      let chosenIdxs = dpSet[bestW] || [];
      if (chosenIdxs.length === 0) {
        // Fallback: choose the tallest remaining item to ensure progress
        let tallest = 0;
        for (let i = 1; i < rest.length; i++) {
          if (rest[i].scaledHeight > rest[tallest].scaledHeight) tallest = i;
        }
        chosenIdxs = [tallest];
      }

      const chosenSet = new Set(chosenIdxs);
      const pageItems = chosenIdxs.map((i) => rest[i]);

      // Optional: sort items on the page by height (tallest first) for nicer layout
      pageItems.sort((a, b) => b.scaledHeight - a.scaledHeight);
      pages.push(pageItems);

      // Remove chosen from rest
      const newRest = [];
      for (let i = 0; i < rest.length; i++) {
        if (!chosenSet.has(i)) newRest.push(rest[i]);
      }
      rest.length = 0;
      Array.prototype.push.apply(rest, newRest);
    }

    return pages;
  }

  // Evaluate solutions and pick the best
  const pagesBFD = packWithBFD(items, contentHeight, imageGap);
  const pagesDP = packWithKnapsack(items, contentHeight, imageGap);

  function score(pages) {
    const slack = pages.reduce((acc, page) => {
      const used = page.reduce(
        (u, it, idx) => u + it.scaledHeight + (idx > 0 ? imageGap : 0),
        0
      );
      return acc + Math.max(0, contentHeight - used);
    }, 0);
    return { count: pages.length, slack, pages };
  }

  const sB = score(pagesBFD);
  const sD = score(pagesDP);
  const best =
    sD.count < sB.count
      ? sD
      : sD.count > sB.count
      ? sB
      : sD.slack <= sB.slack
      ? sD
      : sB;

  return stripHelpers(best.pages);
}

/**
 * Combines PNG files from the trimmed folder into a single optimized PDF document
 */
async function combinePDFs(instrument) {
  const trimmedDir = "trimmed";

  // Check if directory exists
  if (!fs.existsSync(trimmedDir)) {
    console.error("Error: 'trimmed' directory not found!");
    return;
  }

  // Get all PNG files from the trimmed directory
  const imageFiles = fs
    .readdirSync(trimmedDir)
    .filter((file) => file.includes(instrument.file))
    .map((file) => path.join(trimmedDir, file));

  if (imageFiles.length === 0) {
    console.error("No PNG files found in the 'trimmed' directory!");
    return;
  }

  // Analyze each PNG to get image information (no canvas)
  const imageInfo = imageFiles.map((filePath) => {
    try {
      const buffer = fs.readFileSync(filePath);
      const { width, height } = imageSize(buffer);
      return {
        path: filePath,
        filename: path.basename(filePath),
        width,
        height,
      };
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
      return null;
    }
  });

  // Filter out any nulls from failed analyses
  const validImages = imageInfo.filter((info) => info !== null);

  // Previously this sorted by filename; we now group later to minimize pages
  if (validImages.length === 0) {
    console.error("No valid PNG files to render.");
    return;
  }

  // Check for baseline files to determine if we need to create appendix
  const baselineFile = `baseline_${instrument.file
    .toLowerCase()
    .replace("_in_bb", "")}.txt`;
  let originalImages = validImages;
  let appendixImages = [];
  let hasAppendix = false;

  if (fs.existsSync(baselineFile)) {
    console.log(`Found baseline file: ${baselineFile}`);

    // Read baseline file to get original image list
    const baselineContent = fs.readFileSync(baselineFile, "utf8");
    const baselineImagePaths = baselineContent
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.trim());

    // Create a set of baseline filenames for quick lookup
    const baselineFilenames = new Set(
      baselineImagePaths.map((filepath) => path.basename(filepath))
    );

    // Separate original and new images
    originalImages = validImages.filter((img) =>
      baselineFilenames.has(img.filename)
    );

    appendixImages = validImages.filter(
      (img) => !baselineFilenames.has(img.filename)
    );

    hasAppendix = appendixImages.length > 0;

    console.log(`Original images: ${originalImages.length}`);
    console.log(`New images for appendix: ${appendixImages.length}`);

    if (hasAppendix) {
      console.log("New images found:");
      appendixImages.forEach((img) => console.log(`  - ${img.filename}`));
    }
  } else {
    console.log("No baseline file found - generating complete booklet");
  }

  // Create a new PDF writer
  const outputPath = `booklets/${instrument.file}.pdf`;

  // Make sure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Create PDF writer
  const pdfWriter = muhammara.createWriter(outputPath);

  // Track the current page number in the combined PDF
  let pageIndex = 0;
  // Image page number (excludes index pages)
  let imagePageNumber = 0;

  // Collect index entries while placing images
  const indexEntries = [];

  // Try to load a font so we can write text (page numbers and index)
  const fontCandidates = [
    path.join(process.cwd(), "fonts", "Roboto-Regular.ttf"),
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
  ];
  let font = null;
  for (const pth of fontCandidates) {
    try {
      if (fs.existsSync(pth)) {
        font = pdfWriter.getFontForFile(pth);
        break;
      }
    } catch (_) {}
  }
  if (!font) {
    console.warn(
      "Warning: No TTF font found. Page numbers and index will be skipped."
    );
  }

  // Define margins in points (72 points = 1 inch)
  const margin = {
    top: 36,
    bottom: 30,
    left: 40,
    right: 40,
  };

  // A4 page size in points
  const pageWidth = 595.28;
  const pageHeight = 841.89;

  // Content area
  const contentWidth = pageWidth - margin.left - margin.right;
  const contentHeight = pageHeight - margin.top - margin.bottom;

  // Helper to draw right-justified page number at the bottom
  function drawPageNumber(ctx, number) {
    if (!font) return;
    const text = String(number);
    const size = 10;
    let textWidth = 0;
    try {
      textWidth = font.calculateTextDimensions(text, size).width || 0;
    } catch (_) {}
    const x = pageWidth - margin.right - textWidth; // right-justify at right margin
    const y = Math.max(12, margin.bottom / 2);
    ctx.writeText(text, x, y, { font, size });
  }

  // Helper to draw date in the bottom left corner
  function drawDate(ctx) {
    if (!font) return;
    const now = new Date();
    const dateText = now.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const size = 10;
    const x = margin.left;
    const y = Math.max(12, margin.bottom / 2);
    ctx.writeText(dateText, x, y, { font, size });
  }

  // Compute a single global scale so the widest image fits horizontally
  const imageGap = 40;
  const maxWidthPx = Math.max(...validImages.map((i) => i.width));
  const scale = contentWidth / maxWidthPx; // To avoid upscaling, use: Math.min(1, contentWidth / maxWidthPx)

  // Group images into minimal page sets (order by best fit, not filename)
  // Handle original and appendix images separately
  const originalPages = groupImagesIntoPages(
    originalImages,
    contentHeight,
    scale,
    imageGap
  );

  let appendixPages = [];
  if (hasAppendix) {
    appendixPages = groupImagesIntoPages(
      appendixImages,
      contentHeight,
      scale,
      imageGap
    );
  }

  // Combine all pages for processing
  const allPages = [...originalPages, ...appendixPages];

  // Array to store page objects for linking
  const imagePageObjects = [];

  // Array to store index pages for adding links later
  const indexPages = [];

  // Build and render the Index first (so it's the first page[s])
  if (font && validImages.length > 0) {
    // Calculate how many index pages we need
    const lineHeight = 24;
    const titleGap = 30;

    // Create index entries for original images
    indexEntries.push(
      ...originalPages.flatMap((items, pIdx) =>
        items.map((img) => ({
          title: img.filename
            .replace(/\.png$/i, "")
            .replace(
              new RegExp(`-${escapeRegExp(instrument.file)}-\\d+$`, "i"),
              ""
            ),
          page: pIdx + 1, // no offset from index pages
          pageIndex: pIdx, // store the actual page index for linking
          section: "original",
        }))
      )
    );

    // Add appendix entries if they exist
    if (hasAppendix) {
      // Add appendix entries (no separator in index - header on page is sufficient)
      indexEntries.push(
        ...appendixPages.flatMap((items, pIdx) =>
          items.map((img) => ({
            title: img.filename
              .replace(/\.png$/i, "")
              .replace(
                new RegExp(`-${escapeRegExp(instrument.file)}-\\d+$`, "i"),
                ""
              ),
            page: originalPages.length + pIdx + 1,
            pageIndex: originalPages.length + pIdx,
            section: "appendix",
          }))
        )
      );
    }

    // Sort by title
    const sorted = indexEntries.slice().sort((a, b) =>
      a.title.localeCompare(b.title, undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );

    // Render index pages now
    let idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
    let idxCtx = pdfWriter.startPageContentContext(idxPage);
    let y = pageHeight - margin.top;

    // Store all index pages to add links later
    indexPages.push(idxPage);

    const lineSize = 12;

    // Title on first index page
    idxCtx.writeText(
      `Frome Balfolk Tunes  - (${instrument.title})`,
      margin.left,
      y,
      {
        font,
        size: 30,
      }
    );
    y -= titleGap;

    const columnWidth = contentWidth / 2;
    const columnRight = margin.left + columnWidth;
    const gap = 6;
    const dotChar = ".";
    let dotWidth = 0;
    try {
      dotWidth = font.calculateTextDimensions(dotChar, lineSize).width || 0;
    } catch (_) {}

    for (const item of sorted) {
      if (y < margin.bottom + lineHeight) {
        // close current index page (no page number on index pages)
        // Add date to all pages
        drawDate(idxCtx);
        pdfWriter.writePage(idxPage);
        pageIndex++;

        // start a new index page (no title on subsequent pages)
        idxPage = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        idxCtx = pdfWriter.startPageContentContext(idxPage);
        indexPages.push(idxPage); // Store for link creation later
        y = pageHeight - margin.top;
      }

      const pageText = String(item.page);
      let numWidth = 0;
      try {
        numWidth = font.calculateTextDimensions(pageText, lineSize).width || 0;
      } catch (_) {}
      const numX = columnRight - numWidth;

      let maxTitleWidth = numX - margin.left - gap - (dotWidth || 3);

      let titleText = item.title;
      try {
        // Truncate with ellipsis if needed
        const ellipsis = "…";
        let tWidth =
          font.calculateTextDimensions(titleText, lineSize).width || 0;
        if (tWidth > maxTitleWidth) {
          let low = 0,
            high = titleText.length;
          while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            const candidate = titleText.slice(0, mid) + ellipsis;
            const cWidth =
              font.calculateTextDimensions(candidate, lineSize).width || 0;
            if (cWidth <= maxTitleWidth) low = mid;
            else high = mid - 1;
          }
          titleText = titleText.slice(0, low) + ellipsis;
          tWidth = font.calculateTextDimensions(titleText, lineSize).width || 0;
        }

        // Compute dot leader
        const titleWidth = tWidth;
        const dotStartX = margin.left + titleWidth + gap;
        const safetyPad = 2;
        const maxDotsWidth = Math.max(0, numX - gap - dotStartX - safetyPad);

        let dots = "";
        if (maxDotsWidth > 0) {
          if (dotWidth > 0) {
            let count = Math.floor(maxDotsWidth / dotWidth);
            if (count > 0) {
              dots = dotChar.repeat(count);
              try {
                let dotsWidth =
                  font.calculateTextDimensions(dots, lineSize).width || 0;
                while (dots && dotsWidth > maxDotsWidth) {
                  dots = dots.slice(0, -1);
                  dotsWidth =
                    font.calculateTextDimensions(dots, lineSize).width || 0;
                }
              } catch (_) {
                while (dots.length > 0 && dots.length * dotWidth > maxDotsWidth)
                  dots = dots.slice(0, -1);
              }
            }
          } else {
            const approxDotWidth = 3;
            let count = Math.floor(maxDotsWidth / approxDotWidth);
            if (count > 0) dots = dotChar.repeat(count);
          }
        }

        // Handle separators differently - draw without dots or page numbers
        if (item.isSeparator) {
          // Draw separator with centered text and no clickable link
          idxCtx.writeText(titleText, margin.left, y, {
            font,
            size: lineSize + 2,
          });
        } else {
          // Draw: title (left), dots (middle), page number (right edge of half column)
          idxCtx.writeText(titleText, margin.left, y, { font, size: lineSize });
          if (dots)
            idxCtx.writeText(dots, dotStartX, y, { font, size: lineSize });
          idxCtx.writeText(pageText, numX, y, { font, size: lineSize });

          // Add clickable link area covering the entire line
          // We'll need to update this link later once we have the page objects
          const linkHeight = lineHeight;
          const linkY = y - 2; // slight adjustment for better click area
          const linkWidth = columnRight - margin.left;

          // Store link info for later (after we create the image pages)
          if (!idxPage._linkAnnotations) {
            idxPage._linkAnnotations = [];
          }
          idxPage._linkAnnotations.push({
            x: margin.left,
            y: linkY,
            width: linkWidth,
            height: linkHeight,
            targetPageIndex: item.pageIndex,
          });
        }
      } catch (_) {
        // Fallback: just draw minimally if anything fails
        idxCtx.writeText(titleText, margin.left, y, { font, size: lineSize });
        idxCtx.writeText(pageText, numX, y, { font, size: lineSize });
      }

      y -= lineHeight;
    }

    // finalize last index page (no page number on index pages)
    // Add date to all pages
    drawDate(idxCtx);

    // Before writing index pages, we need to create placeholder for links
    // We'll come back and add them after image pages are created
    pdfWriter.writePage(idxPage);
    pageIndex++;
  }

  // Start first image page (after index pages)
  let page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  let contentContext = pdfWriter.startPageContentContext(page);
  let currentY = pageHeight - margin.top;

  // Store the first image page
  imagePageObjects.push(page);

  // Render page-by-page based on grouping
  for (let p = 0; p < allPages.length; p++) {
    // Check if we're starting the appendix section
    const isAppendixStart = hasAppendix && p === originalPages.length;

    if (p > 0) {
      // finalize previous image page and start a new one
      if (font) {
        drawPageNumber(contentContext, imagePageNumber + 1);
        drawDate(contentContext);
      }
      pdfWriter.writePage(page);
      imagePageNumber++;
      pageIndex++;

      page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
      contentContext = pdfWriter.startPageContentContext(page);
      currentY = pageHeight - margin.top;

      // Store this image page
      imagePageObjects.push(page);
    }

    // If starting appendix, add some visual separation
    if (isAppendixStart && font) {
      // Add "New Tunes" header at top of first appendix page
      const headerY = pageHeight - margin.top;
      contentContext.writeText("New Tunes", margin.left, headerY, {
        font,
        size: 20,
      });
      currentY = headerY - 40; // Space after header
    }

    for (const img of allPages[p]) {
      const wPts = img.width * scale;
      const hPts = img.height * scale;

      // Safety: if something doesn't fit due to rounding, spill to a new page
      if (currentY - hPts < margin.bottom) {
        if (font) {
          drawPageNumber(contentContext, imagePageNumber + 1);
          drawDate(contentContext);
        }
        pdfWriter.writePage(page);
        imagePageNumber++;
        pageIndex++;

        page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
        contentContext = pdfWriter.startPageContentContext(page);
        currentY = pageHeight - margin.top;

        // Store this overflow page
        imagePageObjects.push(page);
      }

      const x = margin.left + (contentWidth - wPts) / 2;
      const y = currentY - hPts;

      contentContext.drawImage(x, y, img.path, {
        transformation: { width: wPts, height: hPts },
      });

      let linkSpacing = 0;

      // Check for corresponding link file
      if (font) {
        const tuneBaseName = img.filename
          .replace(/\.png$/i, "")
          .replace(
            new RegExp(`-${escapeRegExp(instrument.file)}-\\d+$`, "i"),
            ""
          );

        const linkFilePath = path.join("trimmed", `${tuneBaseName}_link`);

        if (fs.existsSync(linkFilePath)) {
          try {
            let linkContent = fs.readFileSync(linkFilePath, "utf8").trim();
            if (linkContent) {
              // Ensure URL has proper protocol
              if (
                !linkContent.startsWith("http://") &&
                !linkContent.startsWith("https://")
              ) {
                linkContent = "https://" + linkContent;
              }

              console.log(`Adding link for ${tuneBaseName}: ${linkContent}`);

              // Create user-friendly display text
              let displayText = linkContent;
              if (
                linkContent.includes("youtube.com") ||
                linkContent.includes("youtu.be")
              ) {
                displayText = "▶ Watch on YouTube";
              } else if (linkContent.includes("spotify.com")) {
                displayText = "♪ Listen on Spotify";
              } else if (linkContent.length > 30) {
                // Truncate very long URLs
                displayText = linkContent.substring(0, 30) + "...";
              }

              // Position link text below the image
              const linkY = y - 15; // 15 points below image
              const linkSize = 10;
              const linkColor = [0, 0, 1]; // Blue color for links

              // Calculate text width to center it
              let linkWidth = 0;
              try {
                linkWidth =
                  font.calculateTextDimensions(displayText, linkSize).width ||
                  0;
              } catch (_) {}

              const linkX = margin.left + (contentWidth - linkWidth) / 2;

              // Draw the link text
              contentContext.writeText(displayText, linkX, linkY, {
                font,
                size: linkSize,
                colorspace: "rgb",
                color: linkColor,
              });

              // Store link annotation for later processing (similar to index links)
              if (!page._linkAnnotations) {
                page._linkAnnotations = [];
              }

              page._linkAnnotations.push({
                x: linkX,
                y: linkY - 3,
                width: linkWidth,
                height: linkSize + 6,
                url: linkContent,
                isExternalLink: true,
              });

              linkSpacing = 20; // Extra spacing below link
            }
          } catch (error) {
            console.warn(
              `Could not read link file: ${linkFilePath}`,
              error.message
            );
          }
        }
      }

      currentY -= hPts + imageGap + linkSpacing;
    }
  }

  // Finalize the last image page
  if (font) {
    drawPageNumber(contentContext, imagePageNumber + 1);
    drawDate(contentContext);
  }
  pdfWriter.writePage(page);
  imagePageNumber++;
  pageIndex++;

  // Now add the clickable links to index pages using pdf-lib
  // Use a post-processing approach
  if (font && indexPages.length > 0 && imagePageObjects.length > 0) {
    try {
      // Close current writer
      pdfWriter.end();

      // Load the PDF with pdf-lib
      const pdfBytes = fs.readFileSync(outputPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      // Add links to index pages
      let indexPageNum = 0;
      for (const idxPage of indexPages) {
        if (idxPage._linkAnnotations && idxPage._linkAnnotations.length > 0) {
          const page = pages[indexPageNum];

          for (const linkInfo of idxPage._linkAnnotations) {
            // Calculate target page number (index pages + target image page index)
            const targetPageNum = indexPages.length + linkInfo.targetPageIndex;

            if (targetPageNum < pages.length) {
              const targetPage = pages[targetPageNum];

              // Create link annotation using pdf-lib's low-level API
              const linkAnnotation = pdfDoc.context.obj({
                Type: "Annot",
                Subtype: "Link",
                Rect: [
                  linkInfo.x,
                  linkInfo.y,
                  linkInfo.x + linkInfo.width,
                  linkInfo.y + linkInfo.height,
                ],
                Border: [0, 0, 0],
                C: [0, 0, 1], // Optional: blue color for link (invisible)
                A: {
                  Type: "Action",
                  S: "GoTo",
                  D: [targetPage.ref, "XYZ", null, null, null],
                },
              });

              const linkAnnotationRef = pdfDoc.context.register(linkAnnotation);

              // Add annotation to the page
              const annots = page.node.Annots();
              if (annots) {
                annots.push(linkAnnotationRef);
              } else {
                page.node.set(
                  pdfDoc.context.obj("Annots"),
                  pdfDoc.context.obj([linkAnnotationRef])
                );
              }
            }
          }
        }
        indexPageNum++;
      }

      // Process external links on image pages
      for (let pageNum = 0; pageNum < imagePageObjects.length; pageNum++) {
        const imagePage = imagePageObjects[pageNum];
        if (
          imagePage._linkAnnotations &&
          imagePage._linkAnnotations.length > 0
        ) {
          const pdfLibPage = pages[indexPages.length + pageNum]; // Offset by index pages

          for (const linkInfo of imagePage._linkAnnotations) {
            if (linkInfo.isExternalLink) {
              try {
                // Use pdf-lib's high-level API for URL links
                const { PDFName, PDFString } = await import("pdf-lib");

                // Create external URL link annotation with proper URI encoding
                const urlLinkAnnotation = pdfDoc.context.obj({
                  Type: "Annot",
                  Subtype: "Link",
                  Rect: [
                    linkInfo.x,
                    linkInfo.y,
                    linkInfo.x + linkInfo.width,
                    linkInfo.y + linkInfo.height,
                  ],
                  Border: [0, 0, 0],
                  H: "I", // Highlight mode: Invert
                  A: {
                    Type: "Action",
                    S: "URI",
                    URI: pdfDoc.context.obj(linkInfo.url), // Properly encode as PDF string
                  },
                });

                const urlLinkRef = pdfDoc.context.register(urlLinkAnnotation);

                // Add annotation to the page
                const annots = pdfLibPage.node.Annots();
                if (annots) {
                  annots.push(urlLinkRef);
                } else {
                  pdfLibPage.node.set(
                    pdfDoc.context.obj("Annots"),
                    pdfDoc.context.obj([urlLinkRef])
                  );
                }

                console.log(`✓ Added clickable link: ${linkInfo.url}`);
              } catch (error) {
                console.warn(`Failed to add link: ${error.message}`);
              }
            }
          }
        }
      }

      // Save the modified PDF
      const modifiedPdfBytes = await pdfDoc.save();
      fs.writeFileSync(outputPath, modifiedPdfBytes);

      console.log(`✓ Added clickable links to table of contents`);
    } catch (error) {
      console.warn("Note: Could not create clickable links:", error.message);
    }

    return; // Exit early since we already called end()
  }

  // Finalize the PDF
  pdfWriter.end();

  console.log(
    `${instrument.file}\n   Total pages ${pageIndex}\n   Total Tunes: ${imageFiles.length}`
  );
}

// Execute the function
for (const instrument of instruments) {
  combinePDFs(instrument).catch((error) =>
    console.error(`Error combining images for ${instrument.file}:`, error)
  );
}
