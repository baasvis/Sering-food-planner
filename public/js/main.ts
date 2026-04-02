// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// Imports all modules and assigns onclick-referenced functions to window
// ═══════════════════════════════════════════════════════════════════

import { S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, rebuildStorageCategories, getStorageConfigForLoc, getStorageColor, DEFAULT_STORAGE_CONFIG, NAV_SCREENS, ACCOMPANIMENTS } from './state';
import { handleGoogleLogin, devLogin, doLogout, initGoogleSignIn, checkSession, showApp } from './auth';
import { newId, apiGet, apiPost, setSaveState, takeSnapshot, computePatch, patchIsEmpty, scheduleSave, doSave, retrySave, loadData, showDataError, hideDataError, retryLoad, loadIngredientDb, loadStorageConfig, saveStorageConfig, loadGuestHistory, loadGuestsNextWeeks, scheduleNextWeeksSave, toast, toastError, connectLiveSync, disconnectLiveSync, applyRemotePatch, todayIso, loadPrepChecklist, schedulePrepSave, saveState, ingredientDbLoaded, ingredientDbError, setOnBatchesChanged } from './utils';
import { isBatchCooked, locationBadge, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, rebuildPlanner, renderDishListSplit, sortByCookDate, getGuests, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, cycleStorage, logisticsBadge, logisticsBadgeClass, logisticsShort, cycleLocation, openServedDialog, pendingRatings, ratingButtons, setRating, archiveDish, typeBadge, typeBadgeClass, TYPES, cycleType, toggleOrder, chipClass, getToday, dateToStr, strToDate } from './core';
import { parseCSV, categorizeUploadedFiles, predictGuests, buildFlowDistribution, averageLayers, detectFormat, parseSemicolonCSV, mergeAggregated, categorizeProfitCenterData, categorizeLightspeedData, parseLightspeedMinuteOfDay, parseLightspeedHour, parseLightspeedDate, categorizeTebiData, extractMinuteOfDayFromTebiRow, extractHourFromTebiRow, extractDeviceId, winsorize, percentile, getDayOfWeek, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav, emptyAggregated, AGG_MEALS } from './predictions';
import { showScreen, renderDashboard, setDashboardLoc, setGuestFlowMeal, drawGuestFlowChart, buildGuestFlowData, gaussian, loadDayTodos, saveDayTodos, toggleHeatItem, toggleCookItem, addCustomTodo, toggleCustomTodo, deleteCustomTodo, toggleTeamTodos, renderTeamTodos, togglePrepItem, renderDashboardContent, renderPrepChecklist, navTo, getMenuDishes, calcLitersForService, getVegIngredients, setDishStarch, starchSummaryHtml, isChoppableIngredient, isDishAtLocation, getCookDateDishes, getIngredientCategoryCache, _ingredientCategoryCache, CHOPPABLE_CATEGORIES, PANTRY_KEYWORDS, _guestFlowMeal } from './dashboard';
import { renderGuests, changeGuestDay, getGuestForDay, renderUploadSection, setupUploadHandlers, handleFiles, saveUploadedHistory, applyPredictions, updateGuests, updateGuestsNextWeek, restoreFocusAfterRender, sumCatDays, formatDateShort, _pendingUpload, _guestsDayOffset } from './guests';
import { renderWeekPlan, setPlannerSubTab, renderPlannerSubTab, rerenderCurrentView, changePlannerDay, renderLocationPlan, getPoolBatches, toggleTypeBatchPool, renderTypeBatchPool, toggleShowAllBatches, renderShowAllBatches, batchDragStart, batchDragEnd, slotDragOver, slotDragLeave, slotDrop, startAssignMode, cancelAssignMode, assignBatchToSlot, renderTransportView, addTransportItem, deliverTransportItem, markSelectedArrived, removeDishFromSlot, toggleTypeCollapse, copyDayToOther, copySlotToOther, openAddDishTyped, openAddDish, renderAddModal, updateAddModal, switchAddModalTab, switchAddModalLoc, searchAddModal, confirmAddDish, addRecipeToSlot, addPlaceholderDish, openReplaceBatch, renderReplaceModal, switchReplaceTab, searchReplaceModal, confirmReplaceBatch, replaceWithRecipe, getInventoryState, getInventoryButton, openInventory, updateInventoryStock, openServedFromInventory, finishInventory, _plannerDayOffset } from './planner';
import { renderDishesOverview, dishSortBy, renderBatchTile, toggleBatchExpand, cleanCateringRefs, deleteBatch, inlineEdit, inlineRemoveAllergen, inlineAddAllergenStart, inlineAddAllergenConfirm, getCookDayOptions, isDishCooked, isCookDayToday, isDishStale, daysSinceCooked, batchCookLabel, tileEditCookDate, getCookCellHtml, cookDateToISO, isoToCookDate, setCookDay, setCookDateDirect, confirmCooked, setFilter, toggleSelect, calcRequiredForLoc, renderSplitBar, doSplit, doTransportSplit, openNewDish, searchNewDishModal, openNewDishScratch, saveNewDish, openEditDish, setCookMode, addExtraAllergen, removeExtraAllergen, refreshAllergenTags, refreshRecipe, saveEditDish, deleteDish, dishSort, renderDishGroups, logisticsRowClass } from './dishes';
import { renderCaterings, openNewCatering, saveNewCatering, openEditCatering, renderCateringDishList, openAddCateringDish, renderCateringDishPicker, addCateringDishFromPlanner, removeCateringDish, saveEditCatering, deleteCatering } from './caterings';
import { renderRecipeIndex, updateRecipeResults, updateRiSearch, riSortBy, openAddRecipe, setRiMode, extractSheetId, fetchAndAddRecipe, bulkAddRecipes, openEditRecipe, saveEditRecipe, deleteRecipeIndex, addDishFromRecipe, riSearch, riTypeFilter, riSort, parseCost, costColor, avgRating } from './recipes';
import { renderOrders, switchOrdersTab, switchOrdersLoc, renderStandardInventoryTab, renderDishesTab, renderBatchIngredientTable, renderCombinedOrderTab, toggleBatchIngredient, toggleAllBatchIngredients, toggleCombinedIncludeDishes, copyOrderCodes, copyDishOrderCodes, copySiOrderCodes, copyCombinedOrderCodes, checkHanosStatus, isHanosEnabled, collectHanosItems, hanosAddSingle, hanosConfirmBulk, collectHanosBatchItems, hanosConfirmBulkBatches, showHanosConfirmModal, hanosExecuteFromModal, saveGramsPerPiece, toggleOrderSection, persistIngredientStock, updateCombinedOrderStock, updateOrderStock, refreshAllRecipes, startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, updateStocktakeToOrder, saveStocktakeArea, exitStocktake, buildCombinedOrderData, getIngredientsForArea, toBaseUnit, normalizeSupplier, formatAmount, lookupIngredient, getDbStockTotal, hasDbStockEntry, formatStorageLoc, getStorageCategory, renderStorageBadge, calcOrderUnits, getStandardInventoryItems, updateSiSearch, hideSiSuggestions, addToStandardInventory, removeSiItem, updateSiTarget, updateSiStock, resetBatchToggles } from './orders';
import { renderIngredientDbTab, loadIngredientDbFull, updateIngredientSearch, getFilteredIngredients, renderTypePills, renderPriceLevel, renderInlineStock, saveInlineStock, renderStockBadges, renderIngredientEditRow, showInlineCategoryEdit, saveInlineCategory, updateStorageLocOpts, updateEditCategoryOptions, saveIngredientEdit, toggleIngredientActive, deleteIngredient, openIngredientModal, saveIngredientFromModal, hanosLookupProduct, openAddIngredientModal, saveNewIngredient, openStoragePopover, updatePopStorageLoc, saveStorageFromPopover, handleSupplierUpload, renderSupplierImportPanel, applySupplierUpdate, openStorageLocationsModal, renderStorageModal, ingredientMatchesTypeFilter, getCategoriesForTypeFilter, dropStorageArea, updateStorageColor, addStorageCategory, removeStorageCategory, addStorageSpot, removeStorageSpot, openMigrationModal, runMigration, storageModalLoc, storageModalDragIdx, setIngredientDbEditId } from './ingredient-db';
import { renderFinance, loadFinanceData, loadFinanceProducts, checkSyncStatus, triggerSync, renderProductBreakdown, setFinanceProductFilter, cancelSync, changeFinanceWeek, getFinanceMonday, fmtDate, fmtDateShort, fmtEuro, fmtEuroFull, SERVICE_PERIODS, FINANCE_LOCATIONS } from './finance';
import { openFeedback, selectFeedbackType, submitFeedback, showFeedbackFab, feedbackTypes, feedbackSelectedType } from './feedback';
import { renderFeedbackAdmin, setFeedbackFilter, copyFeedbackForClaude, formatFeedbackDate, feedbackData, feedbackFilter } from './feedback-admin';
import { TUTORIALS, startTutorial, tutNext, tutPrev, tutSkip } from './tutorial';
import { toggleTheme, showModal, closeModal, esc, buildNav, initApp, bootstrap } from './init';

// ═══════════════════════════════════════════════════════════════════
// Wire up cross-module callbacks (avoids circular imports)
setOnBatchesChanged(resetBatchToggles);

// Assign all functions called from onclick="" to window
// ═══════════════════════════════════════════════════════════════════
Object.assign(window, {
  // state
  S, DAYS, MEALS, STORAGE, LOCATIONS, ALLERGENS, INGREDIENT_TYPES, INGREDIENT_CATEGORIES, INGREDIENT_TYPE_TO_GROUP, ALL_CATEGORIES, PRICE_LEVELS, STORAGE_CATEGORIES, rebuildStorageCategories, getStorageConfigForLoc, getStorageColor, DEFAULT_STORAGE_CONFIG, NAV_SCREENS, ACCOMPANIMENTS,

  // auth
  handleGoogleLogin, devLogin, doLogout, initGoogleSignIn, checkSession, showApp,

  // utils
  newId, apiGet, apiPost, setSaveState, takeSnapshot, computePatch, patchIsEmpty, scheduleSave, doSave, retrySave, loadData, showDataError, hideDataError, retryLoad, loadIngredientDb, loadStorageConfig, saveStorageConfig, loadGuestHistory, loadGuestsNextWeeks, scheduleNextWeeksSave, toast, toastError, connectLiveSync, disconnectLiveSync, applyRemotePatch, todayIso, loadPrepChecklist, schedulePrepSave,

  // core
  isBatchCooked, locationBadge, getAmsterdamNow, dateToDayName, dateToIso, isServicePast, rebuildPlanner, renderDishListSplit, sortByCookDate, getGuests, calcRequired, calcRequiredBreakdown, calcTotalGuests, calcIngredientsFromRecipe, diffStr, storageBadge, storageBadgeClass, cycleStorage, logisticsBadge, logisticsBadgeClass, logisticsShort, cycleLocation, openServedDialog, ratingButtons, setRating, archiveDish, typeBadge, typeBadgeClass, TYPES, cycleType, toggleOrder, chipClass, getToday, dateToStr, strToDate,

  // predictions
  parseCSV, categorizeUploadedFiles, predictGuests, buildFlowDistribution, averageLayers, detectFormat, parseSemicolonCSV, mergeAggregated, getVisibleDays, getMondayKeyForDate, localDateStr, renderDayNav,

  // dashboard
  showScreen, renderDashboard, setDashboardLoc, setGuestFlowMeal, drawGuestFlowChart, buildGuestFlowData, loadDayTodos, saveDayTodos, toggleHeatItem, toggleCookItem, addCustomTodo, toggleCustomTodo, deleteCustomTodo, toggleTeamTodos, renderTeamTodos, togglePrepItem, renderDashboardContent, renderPrepChecklist, navTo, getMenuDishes, calcLitersForService, getVegIngredients, setDishStarch, starchSummaryHtml, isChoppableIngredient, isDishAtLocation, getCookDateDishes,

  // guests
  renderGuests, changeGuestDay, getGuestForDay, renderUploadSection, setupUploadHandlers, handleFiles, saveUploadedHistory, applyPredictions, updateGuests, updateGuestsNextWeek, restoreFocusAfterRender,

  // planner
  renderWeekPlan, setPlannerSubTab, renderPlannerSubTab, rerenderCurrentView, changePlannerDay, renderLocationPlan, getPoolBatches, toggleTypeBatchPool, renderTypeBatchPool, toggleShowAllBatches, renderShowAllBatches, batchDragStart, batchDragEnd, slotDragOver, slotDragLeave, slotDrop, startAssignMode, cancelAssignMode, assignBatchToSlot, renderTransportView, addTransportItem, deliverTransportItem, markSelectedArrived, removeDishFromSlot, toggleTypeCollapse, copyDayToOther, copySlotToOther, openAddDishTyped, openAddDish, renderAddModal, updateAddModal, switchAddModalTab, switchAddModalLoc, searchAddModal, confirmAddDish, addRecipeToSlot, addPlaceholderDish, openReplaceBatch, renderReplaceModal, switchReplaceTab, searchReplaceModal, confirmReplaceBatch, replaceWithRecipe, getInventoryState, getInventoryButton, openInventory, updateInventoryStock, openServedFromInventory, finishInventory,

  // dishes
  renderDishesOverview, dishSortBy, renderBatchTile, toggleBatchExpand, cleanCateringRefs, deleteBatch, inlineEdit, inlineRemoveAllergen, inlineAddAllergenStart, inlineAddAllergenConfirm, getCookDayOptions, isDishCooked, isCookDayToday, isDishStale, daysSinceCooked, batchCookLabel, tileEditCookDate, getCookCellHtml, cookDateToISO, isoToCookDate, setCookDay, setCookDateDirect, confirmCooked, setFilter, toggleSelect, calcRequiredForLoc, renderSplitBar, doSplit, doTransportSplit, openNewDish, searchNewDishModal, openNewDishScratch, saveNewDish, openEditDish, setCookMode, addExtraAllergen, removeExtraAllergen, refreshAllergenTags, refreshRecipe, saveEditDish, deleteDish,

  // caterings
  renderCaterings, openNewCatering, saveNewCatering, openEditCatering, renderCateringDishList, openAddCateringDish, renderCateringDishPicker, addCateringDishFromPlanner, removeCateringDish, saveEditCatering, deleteCatering,

  // recipes
  renderRecipeIndex, updateRecipeResults, updateRiSearch, riSortBy, openAddRecipe, setRiMode, extractSheetId, fetchAndAddRecipe, bulkAddRecipes, openEditRecipe, saveEditRecipe, deleteRecipeIndex, addDishFromRecipe,

  // orders
  renderOrders, switchOrdersTab, switchOrdersLoc, renderStandardInventoryTab, renderDishesTab, renderBatchIngredientTable, renderCombinedOrderTab, toggleBatchIngredient, toggleAllBatchIngredients, toggleCombinedIncludeDishes, copyOrderCodes, copyDishOrderCodes, copySiOrderCodes, copyCombinedOrderCodes, checkHanosStatus, isHanosEnabled, collectHanosItems, hanosAddSingle, hanosConfirmBulk, collectHanosBatchItems, hanosConfirmBulkBatches, showHanosConfirmModal, hanosExecuteFromModal, saveGramsPerPiece, toggleOrderSection, persistIngredientStock, updateCombinedOrderStock, updateOrderStock, refreshAllRecipes, startStocktake, renderStocktakeAreaPicker, enterStocktakeArea, renderStocktakeArea, updateStocktakeToOrder, saveStocktakeArea, exitStocktake, buildCombinedOrderData, getIngredientsForArea, toBaseUnit, normalizeSupplier, formatAmount, lookupIngredient, getDbStockTotal, hasDbStockEntry, formatStorageLoc, getStorageCategory, renderStorageBadge, calcOrderUnits, getStandardInventoryItems, updateSiSearch, hideSiSuggestions, addToStandardInventory, removeSiItem, updateSiTarget, updateSiStock,

  // ingredient-db
  renderIngredientDbTab, loadIngredientDbFull, updateIngredientSearch, getFilteredIngredients, renderTypePills, renderPriceLevel, renderInlineStock, saveInlineStock, renderStockBadges, renderIngredientEditRow, showInlineCategoryEdit, saveInlineCategory, updateStorageLocOpts, updateEditCategoryOptions, saveIngredientEdit, toggleIngredientActive, deleteIngredient, openIngredientModal, saveIngredientFromModal, hanosLookupProduct, openAddIngredientModal, saveNewIngredient, openStoragePopover, updatePopStorageLoc, saveStorageFromPopover, handleSupplierUpload, renderSupplierImportPanel, applySupplierUpdate, openStorageLocationsModal, renderStorageModal, dropStorageArea, updateStorageColor, addStorageCategory, removeStorageCategory, addStorageSpot, removeStorageSpot, openMigrationModal, runMigration, setIngredientDbEditId,

  // finance
  renderFinance, loadFinanceData, loadFinanceProducts, checkSyncStatus, triggerSync, renderProductBreakdown, setFinanceProductFilter, cancelSync, changeFinanceWeek,

  // feedback
  openFeedback, selectFeedbackType, submitFeedback, showFeedbackFab,

  // feedback-admin
  renderFeedbackAdmin, setFeedbackFilter, copyFeedbackForClaude,

  // tutorial
  startTutorial, tutNext, tutPrev, tutSkip,

  // init
  toggleTheme, showModal, closeModal, esc, buildNav, initApp, bootstrap,
});

// ═══════════════════════════════════════════════════════════════════
// Bootstrap the app
// ═══════════════════════════════════════════════════════════════════
bootstrap();
