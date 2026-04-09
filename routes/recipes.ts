import express, { Request, Response } from 'express';
import { prisma, dbAppendLog } from '../lib/db';
import { getSheetsClient } from '../lib/recipe-sheets';
import { asyncHandler } from '../lib/config';

const router = express.Router();

router.get('/recipe-index', asyncHandler(async (_req: Request, res: Response) => {
  const rows = await prisma.recipeIndex.findMany();
  res.json(rows.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    recipeSheetId: r.recipeSheetId,
    allergens: r.allergens,
    costPerServing: r.costPerServing,
    structure: r.structure,
    seasonality: r.seasonality,
    servingTemp: r.servingTemp,
    servingSize: r.servingSize,
    recipeVolume: r.recipeVolume,
    recipeIngredients: r.recipeIngredients,
    createdAt: r.createdAt,
    avgSkill: r.avgSkill,
    avgSpeed: r.avgSpeed,
    avgBanger: r.avgBanger,
    timesServed: r.timesServed,
  })));
}));

router.post('/recipe-index', asyncHandler(async (req: Request, res: Response) => {
  const recipe = req.body;
  if (!recipe || !recipe.id || !recipe.name) return res.status(400).json({ error: 'id and name required' });
  await prisma.recipeIndex.upsert({
    where: { id: recipe.id },
    create: {
      id: recipe.id,
      name: recipe.name,
      type: recipe.type || 'Soup',
      recipeSheetId: recipe.recipeSheetId || null,
      allergens: recipe.allergens || [],
      costPerServing: recipe.costPerServing || '',
      structure: recipe.structure || '',
      seasonality: recipe.seasonality || '',
      servingTemp: recipe.servingTemp || '',
      servingSize: recipe.servingSize || 280,
      recipeVolume: recipe.recipeVolume || null,
      recipeIngredients: recipe.recipeIngredients || undefined,
      createdAt: recipe.createdAt || new Date().toISOString(),
      avgSkill: recipe.avgSkill || 0,
      avgSpeed: recipe.avgSpeed || 0,
      avgBanger: recipe.avgBanger || 0,
      timesServed: recipe.timesServed || 0,
    },
    update: {
      name: recipe.name,
      type: recipe.type || 'Soup',
      recipeSheetId: recipe.recipeSheetId || null,
      allergens: recipe.allergens || [],
      costPerServing: recipe.costPerServing || '',
      structure: recipe.structure || '',
      seasonality: recipe.seasonality || '',
      servingTemp: recipe.servingTemp || '',
      servingSize: recipe.servingSize || 280,
      recipeVolume: recipe.recipeVolume || null,
      recipeIngredients: recipe.recipeIngredients || undefined,
      avgSkill: recipe.avgSkill || 0,
      avgSpeed: recipe.avgSpeed || 0,
      avgBanger: recipe.avgBanger || 0,
      timesServed: recipe.timesServed || 0,
    },
  });
  const user = req.user || { email: 'anonymous', name: 'Anonymous' };
  dbAppendLog(user.email, user.name, 'recipe-index', `saved "${recipe.name}"`);
  res.json({ ok: true });
}));

router.delete('/recipe-index/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = req.params.id as string;
  await prisma.recipeIndex.delete({ where: { id } });
  res.json({ ok: true });
}));

// External recipe reading — still uses Google Sheets API
router.get('/recipe', asyncHandler(async (req: Request, res: Response) => {
  const { sheetId } = req.query;
  if (!sheetId) return res.status(400).json({ error: 'sheetId required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(sheetId as string)) return res.status(400).json({ error: 'Invalid sheetId format' });

  const sheets = getSheetsClient();
  if (!sheets) return res.status(503).json({ error: 'Google Sheets not configured' });

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: sheetId as string, ranges: ['C1','B3','D3','F3','H3','K2','K4','O3','O4','J6:N80','X6:X80','K6:K80'],
  });
  const vals = response.data.valueRanges!;
  const dishName    = vals[0].values?.[0]?.[0] || '';
  const serving     = parseFloat((vals[1].values?.[0]?.[0]||'280').toString().replace(',','.')) || 280;
  const allergens   = (vals[2].values?.[0]?.[0]||'').split(',').map((s: string)=>s.trim()).filter(Boolean);
  const servingTemp = vals[3].values?.[0]?.[0] || '';
  const structure   = vals[4].values?.[0]?.[0] || '';
  const dishType    = vals[5].values?.[0]?.[0] || '';
  const recipeVol   = parseFloat((vals[6].values?.[0]?.[0]||'0').toString().replace(',','.')) || 0;
  const seasonality = vals[7].values?.[0]?.[0] || '';
  const costPerServing = vals[8].values?.[0]?.[0] || '';
  const ingRows     = vals[9].values || [];
  const sourceRows  = vals[10].values || [];
  const unitRows    = vals[11].values || [];
  const ingredients: Array<{ name: string; amount: number; unit: string; source: string }> = [];
  const seen = new Set<string>();
  ingRows.forEach((row: (string | undefined)[], i: number) => {
    if (!row[0]) return;
    const rawStr = row[2] ? String(row[2]).replace(',','.') : '';
    const cookedStr = row[3] ? String(row[3]).replace(',','.') : '';
    const rawAmt = parseFloat(rawStr) || 0;
    const cookedAmt = parseFloat(cookedStr) || 0;
    const amount = rawAmt > 0 ? rawAmt : cookedAmt;
    if (!amount || amount <= 0) return;
    if (row[0].length > 80) return;
    const key = row[0].toLowerCase().trim();
    if (seen.has(key)) return;
    seen.add(key);
    const unit = (unitRows[i] && unitRows[i][0]) || 'Grams';
    ingredients.push({
      name: row[0],
      amount,
      unit,
      source: (sourceRows[i] && sourceRows[i][0]) || '',
    });
  });
  res.json({ dishName, serving, allergens, servingTemp, structure, dishType, recipeVolume: recipeVol, seasonality, costPerServing, ingredients });
}));

export default router;
